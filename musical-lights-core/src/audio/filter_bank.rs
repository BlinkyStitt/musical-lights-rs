//! Use a bank of filters for audio processing.
//!
//! This is an alternative to the code in [`BufferedFFT`].
use crate::logging::trace;
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

/// 30 ms @ 100 FPS. TODO: need to tune this based on real fps
const EMA_ALPHA: f32 = 0.716_531;

/// ≈2 s fall
///
/// TODO: tune this
const PEAK_DECAY: f32 = 0.995;

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

/*──────────────────── Filter‑bank Struct ───────────────────────*/

/// 24‑band Bark filter‑bank (Direct‑Form II Transposed biquads).
pub struct BarkBank {
    /// 1st biquad per band
    sec1: [MaybeUninit<DirectForm2Transposed<f32>>; BARK_BANDS],
    /// 2nd biquad (identical)
    sec2: [MaybeUninit<DirectForm2Transposed<f32>>; BARK_BANDS],
    /// smoothed loudness (0‑1)
    /// The first 5 bands are combined
    bars: [f32; BARK_BANDS - 4],
    map: [usize; BARK_BANDS],
    peak: f32,
}

/// /Ihavenoideawhatimdoingdog.jpg
type Section = DirectForm2Transposed<f32>;

impl BarkBank {
    pub const fn uninit() -> Self {
        let filters = [MaybeUninit::uninit(); BARK_BANDS];

        let bars = [0.0; BARK_BANDS - 4];

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
        }
    }

    /// Build filters for a given sample rate.
    pub fn init(&mut self, sample_hz: f32) {
        let sample_hz = (sample_hz).hz();

        for band in 0..BARK_BANDS {
            let (lo, hi) = (BARK_EDGES[band], BARK_EDGES[band + 1]);
            let fc = if lo > 0.0 { (lo * hi).sqrt() } else { hi * 0.5 };
            let q = (fc / (hi - lo)) * Q_BOOST;
            let c = Coefficients::from_params(Type::BandPass, sample_hz, fc.hz(), q).unwrap();

            self.sec1[band].write(DirectForm2Transposed::<f32>::new(c));
            self.sec2[band].write(DirectForm2Transposed::<f32>::new(c));
        }
    }

    pub fn new(sample_hz: f32) -> Self {
        let mut x = Self::uninit();
        x.init(sample_hz);

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
                transmute::<
                    &mut [std::mem::MaybeUninit<Section>; BARK_BANDS],
                    &mut [Section; BARK_BANDS],
                >(&mut self.sec1),
                transmute::<
                    &mut [std::mem::MaybeUninit<Section>; BARK_BANDS],
                    &mut [Section; BARK_BANDS],
                >(&mut self.sec2),
                &self.map,
            )
        }
    }

    /// TODO: can't decide if pcm should be i16 or i24 or f32
    pub fn process_block<'a>(&'a mut self, pcm: &[f32]) -> &'a [f32; BARK_BANDS - 4] {
        let (sec1, sec2, map) = self.sections();

        // TODO: have this be allocated during the `new`?
        let mut tmp = [0.0f32; BARK_BANDS - 4];

        /* 1. 4‑pole Bark power */
        for &x in pcm {
            for ((s1, s2), &i) in sec1.iter_mut().zip(sec2.iter_mut()).zip(map.iter()) {
                // cascade
                let y = s2.run(s1.run(x));
                tmp[i] += y * y;
            }
        }

        let norm = 1.0 / pcm.len() as f32;
        for v in &mut tmp {
            *v *= norm;
        }

        /* 2. ISO weighting + cube‑root */
        for (t, g) in tmp.iter_mut().zip(ISO60_GAIN.iter()) {
            *t = (*t * g).powf(0.33);
        }

        /* 3. 30 ms EMA */
        // TODO: I'm not actually sure about this. i think we might want a "peak" tracker here too.
        (0..BARK_BANDS - 4).for_each(|i| {
            self.bars[i] = EMA_ALPHA * self.bars[i] + (1.0 - EMA_ALPHA) * tmp[i];
        });

        /* 4. auto‑gain (peak‑hold with decay) */
        self.peak *= PEAK_DECAY;

        // TODO: need to think more about this init value. 1.0 seems to look okay
        let frame_peak = self.bars.iter().copied().fold(1.0, f32::max);

        self.peak = self.peak.max(frame_peak);

        trace!("peak: {}", self.peak);

        // scale everything from 0-1?
        for v in &mut self.bars {
            *v /= self.peak;
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
    fn filterbank_len() {
        let b = BarkBank::new(48_000.);
        assert_eq!(b.sec1.len(), BARK_BANDS);
        assert_eq!(b.sec2.len(), BARK_BANDS);
    }
}
