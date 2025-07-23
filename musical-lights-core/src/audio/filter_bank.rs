//! Use a bank of filters for audio processing.
//!
//! This is an alternative to the code in [`BufferedFFT`].
use crate::{
    logging::{info, trace},
    remap,
};
use biquad::{
    Biquad, DirectForm2Transposed,
    coefficients::{Coefficients, Type},
    frequency::ToHertz,
};
use core::mem::{MaybeUninit, transmute};

#[allow(unused_imports)]
use micromath::F32Ext;

/// normally this is 24, but maybe i want to capture the highest frequencies and do 25?
const BARK_BANDS: usize = 24;

/// combine the bottom 5 bands into a single bass band
const BARKISH_BANDS: usize = BARK_BANDS - 4;

/// ≈⅓ Bark
const Q_BOOST: f32 = 3.0;

/// Zwicker / Traunmüller Bark band edges (Hz).
///
/// TODO: instead of hard coding bark, have our exponential helper
const BARK_EDGES: [f32; BARK_BANDS + 1] = [
    0.0, 100.0, 200.0, 300.0, 400.0, 510.0, 630.0, 770.0, 920.0, 1080.0, 1270.0, 1480.0, 1720.0,
    2000.0, 2320.0, 2700.0, 3150.0, 3700.0, 4400.0, 5300.0, 6400.0, 7700.0, 9500.0, 12_000.0,
    15_500.0,
];

/// Inverse 60‑phon equal‑loudness gains (ISO‑226 2023, smoothed).
///
/// TODO: this is just from an LLM. check the math
/// TODO: I'm turning up the bass a bunch because the mac laptop mic drops it. this isn't really the right way to do it
const ISO60_GAIN: [f32; BARK_BANDS] = [
    0.0891, 0.1259, 0.1585, 0.1995, 0.2985, 0.3548, 0.4217, 0.4729, 0.5311, 0.5964, 0.6309, 0.6683,
    0.7079, 0.7499, 0.7943, 0.8412, 0.8909, 0.9433, 1.0000, 1.1220, 1.2589, 1.4125, 1.6768, 2.1060,
];

#[inline]
pub fn ema_alpha(fps: f32, tau_ms: f32) -> f32 {
    // frame duration
    let dt = 1.0 / fps;

    // ms → s
    let tau = tau_ms * 1e-3;

    (-dt / tau).exp()
}

/// Generic attack–release envelope
#[derive(Copy, Clone)]
pub struct Envelope {
    value: f32,
    attack: f32,
    release: f32,
}
impl Envelope {
    pub fn new(atk_ms: f32, rel_ms: f32, fps: f32) -> Self {
        let dt = 1.0 / fps;
        let tau_a = atk_ms * 1e-3;
        let tau_r = rel_ms * 1e-3;
        let attack = if atk_ms <= 0.0 {
            1.0
        } else {
            (-dt / tau_a).exp()
        };
        let release = (-dt / tau_r).exp();
        Envelope {
            value: 0.0,
            attack,
            release,
        }
    }

    #[inline]
    pub fn update(&mut self, x: f32) {
        let α = if x > self.value {
            self.attack
        } else {
            self.release
        };
        self.value = α * self.value + (1.0 - α) * x;
    }
}

/// 24‑band Bark filter‑bank (Direct‑Form II Transposed biquads).
pub struct BarkBank {
    /// 1st biquad per band
    sec1: [MaybeUninit<DirectForm2Transposed<f32>>; BARK_BANDS],
    /// 2nd biquad (identical)
    sec2: [MaybeUninit<DirectForm2Transposed<f32>>; BARK_BANDS],
    /// smoothed loudness (0‑1)
    /// The first 5 bands are combined
    bars: [f32; BARKISH_BANDS],
    map: [usize; BARK_BANDS],
    peak: f32,
    /// TODO: is an EMA actually what we want? don't we actually just want to average the last 30ms
    ema_alpha: f32,
    /// TODO: replace this with a dagc
    peak_decay: f32,
}

/// /Ihavenoideawhatimdoingdog.jpg
type Section = DirectForm2Transposed<f32>;

impl BarkBank {
    pub const fn uninit() -> Self {
        let filters = [MaybeUninit::uninit(); BARK_BANDS];

        let bars = [0.0; BARKISH_BANDS];

        let peak = 0.0;

        let map = [
            0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        ];

        Self {
            sec1: filters,
            sec2: filters,
            bars,
            map,
            peak,
            ema_alpha: 1.0,
            peak_decay: 1.0,
        }
    }

    /// Build filters for a given sample rate.
    pub fn init(&mut self, fps_target: f32, sample_hz: f32) {
        let sample_hz = (sample_hz).hz();

        // TODO: let tau_ms be configurable to? i think we always want 30ms since thats human-centric number
        // TODO: should it update the fps target based on the actual
        self.ema_alpha = ema_alpha(fps_target, 30.);
        self.peak_decay = ema_alpha(fps_target, 2_000.);

        info!("ema_alpha: {}", self.ema_alpha);
        info!("peak_decay: {}", self.peak_decay);

        for band in 0..BARK_BANDS {
            let (lo, hi) = (BARK_EDGES[band], BARK_EDGES[band + 1]);
            let fc = if lo > 0.0 { (lo * hi).sqrt() } else { hi * 0.5 };
            let q = (fc / (hi - lo)) * Q_BOOST;
            let c = Coefficients::from_params(Type::BandPass, sample_hz, fc.hz(), q).unwrap();

            self.sec1[band].write(DirectForm2Transposed::<f32>::new(c));
            self.sec2[band].write(DirectForm2Transposed::<f32>::new(c));
        }
    }

    pub fn new(fps_target: f32, sample_hz: f32) -> Self {
        let mut x = Self::uninit();
        x.init(fps_target, sample_hz);
        x
    }

    #[inline(always)]
    fn sections(
        &mut self,
    ) -> (
        &mut [Section; BARK_BANDS],
        &mut [Section; BARK_BANDS],
        &[usize; BARK_BANDS],
    ) {
        // assert!(self.ready, "BarkBank::init() not called");
        unsafe {
            (
                transmute::<&mut [MaybeUninit<Section>; BARK_BANDS], &mut [Section; BARK_BANDS]>(
                    &mut self.sec1,
                ),
                transmute::<&mut [MaybeUninit<Section>; BARK_BANDS], &mut [Section; BARK_BANDS]>(
                    &mut self.sec2,
                ),
                &self.map,
            )
        }
    }

    /// TODO: can't decide if pcm should be i16 or i24 or f32
    pub fn push_samples<'a>(&'a mut self, pcm: &[f32]) -> &'a [f32; BARKISH_BANDS] {
        let (sec1, sec2, map) = self.sections();

        // TODO: move this onto self and just call .fill(0.0) here?
        let mut tmp = [0.0f32; BARKISH_BANDS];

        /* 1. 4‑pole Bark power */
        for &x in pcm {
            for ((s1, s2), &i) in sec1.iter_mut().zip(sec2.iter_mut()).zip(map.iter()) {
                // cascade
                let y = s2.run(s1.run(x));
                // sume the squares
                tmp[i] += y * y;
            }
        }

        /* 2. Take the average + Root-mean-square + ISO weighting + compression */
        let norm = 1.0 / pcm.len() as f32;
        for (t, g) in tmp.iter_mut().zip(ISO60_GAIN.iter()) {
            // TODO: include sqrt so that we have RMS? I think that is the right thing to calculate, but a tone sweep looks worse
            // *t = ((*t * norm).sqrt() * g).powf(1.0 / 3.0);
            // *t = (*t * norm * g).powf(1.0 / 3.0);
            // *t = (*t * norm * g).powf(0.2);
            // *t = ((*t * norm).sqrt() * g).powf(0.2);
            *t = (*t * norm).sqrt() * g;
        }

        /* 3. 30 ms EMA */
        // TODO: I'm not actually sure about this. i think we might want a "peak" tracker here too. but some audio papers said to use an EMA
        // TODO: but also we have an AGC and that does some averaging too. I have no idea what i'm doing!
        // TODO: self.ema_alpha isn't a const anymore. is this `1 - ema_alpha` fast enough or do we need to cache that?
        (0..BARKISH_BANDS).for_each(|i| {
            self.bars[i] = self.ema_alpha * self.bars[i] + (1.0 - self.ema_alpha) * tmp[i];
        });

        /* 4. auto‑gain (peak‑hold with decay) */
        // TODO: use a real AGC
        self.peak *= self.peak_decay;

        // TODO: need to think more about this init value. 1.0 seems to look okay on the mac terminal, but the esp32 doesn't hear anything
        // TODO: change init to a config value. make pressing a button move it up or down?
        // TODO: init with some calculated value instead of a hard coded value. the mac and arduino mics are definitely different
        let frame_peak = self.bars.iter().copied().fold(0.5, f32::max);

        // TODO: still unsure if we should do an EMA on this or have it use the peak
        self.peak = self.peak.max(frame_peak);
        // self.peak = self.peak_decay * self.peak + (1.0 - self.peak_decay) * frame_peak;
        trace!("peak: {}", self.peak);

        // scale everything from 0-1?
        for v in &mut self.bars {
            *v = remap(*v, 0.0, self.peak, 0.0, 1.0);
        }

        &self.bars
    }
}

// /// TODO: document this more. whats the powf doing?
// #[inline(always)]
// pub fn loudness_in_place(buf: &mut [f32; 24]) {
//     for (b, g) in buf.iter_mut().zip(ISO60_GAIN) {
//         // *b = *b * g;
//         // *b = (*b * g).powf(0.33);
//         *b = b.powf(0.33);
//         // *b = b.sqrt()
//     }
// }

// /// TODO: document this better. do we need it to be const? probably not
// #[inline(always)]
// pub fn ema_in_place<const N: usize>(buf: &mut [f32; N], state: &mut [f32; N], alpha: f32) {
//     for (x, e) in buf.iter_mut().zip(state.iter_mut()) {
//         *e = alpha * *e + (1.0 - alpha) * *x;
//         *x = *e;
//     }
// }

#[cfg(test)]
mod tests {
    use super::*;

    /*
    #[test]
    fn ema_converges() {
        let mut state = [0.0f32; 3];
        for _ in 0..20 {
            let mut input = [1.0f32, 1.0, 1.0];

            ema_in_place(&mut input, &mut state, 0.6);

            dbg!(state);
        }
        assert!((state[0] - 1.0).abs() < 1e-3);
    }

    #[test]
    fn loudness_order_kept() {
        let mut v = [0.0f32; 24];
        v[0] = 4.0;
        v[1] = 1.0;
        loudness_in_place(&mut v);
        assert!(v[0] > v[1]);
    }
    */

    #[test]
    fn test_ema_alpha() {
        // TODO: approx_eq float helper
        assert_eq!(ema_alpha(100., 30.), 0.716_531_34);
        assert_eq!(ema_alpha(100., 2_000.), 0.99501246);
        assert_eq!(ema_alpha(100., 5_000.), 0.998002);
    }

    #[test]
    fn filterbank_len() {
        let b = BarkBank::new(100.0, 48_000.);
        assert_eq!(b.sec1.len(), BARK_BANDS);
        assert_eq!(b.sec2.len(), BARK_BANDS);
    }
}
