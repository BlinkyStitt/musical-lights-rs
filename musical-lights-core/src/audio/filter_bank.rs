//! Use a bank of filters for audio processing.
//!
//! An alternative to the code in [`BufferedFFT`].
//!
//! My original design (inspired by things built with a Teensy Audio Board) used an FFT.
use biquad::{
    Biquad, DirectForm2Transposed,
    coefficients::{Coefficients, Type},
    frequency::ToHertz,
};
use core::mem::{MaybeUninit, transmute};
// use static_cell::{ConstStaticCell, StaticCell};

#[cfg(not(any(feature = "std", feature = "libm")))]
use micromath::F32Ext;

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
    bars: [f32; BARK_BANDS],
    peak: f32,
}

type Section = DirectForm2Transposed<f32>;

impl BarkBank {
    pub const fn uninit() -> Self {
        let filters = [MaybeUninit::uninit(); BARK_BANDS];

        let bars = [0.0; BARK_BANDS];

        let peak = 0.0;

        Self {
            sec1: filters,
            sec2: filters,
            bars,
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
    fn sections(&mut self) -> (&mut [Section; 24], &mut [Section; 24]) {
        // assert!(self.ready, "BarkBank::init() not called");
        unsafe {
            (
                transmute::<&mut [std::mem::MaybeUninit<Section>; 24], &mut [Section; 24]>(
                    &mut self.sec1,
                ),
                transmute::<&mut [std::mem::MaybeUninit<Section>; 24], &mut [Section; 24]>(
                    &mut self.sec2,
                ),
            )
        }
    }

    /// TODO: can't decide if pcm should be i16 or i24 or f32
    pub fn process_block<'a>(&'a mut self, pcm: &[f32]) -> &'a [f32; 24] {
        let (sec1, sec2) = self.sections();

        // TODO: have this be allocated during the `new`?
        let mut tmp = [0.0f32; BARK_BANDS];

        /* 1. 4‑pole Bark power */
        for &x in pcm {
            for ((s1, s2), t) in sec1.iter_mut().zip(sec2.iter_mut()).zip(tmp.iter_mut()) {
                // cascade
                let y = s2.run(s1.run(x));
                *t += y * y;
            }
        }

        let norm = 1.0 / pcm.len() as f32;
        for v in &mut tmp {
            *v *= norm;
        }

        /* 2. ISO weighting + cube‑root */
        for i in 0..BARK_BANDS {
            tmp[i] = (tmp[i] * ISO60_GAIN[i]).powf(0.33);
        }

        // TODO: I'm not actually sure about this. i think we might want a "peak" tracker here too.
        // TODO: should this track peaks better?
        /* 3. 30 ms EMA */
        (0..BARK_BANDS).for_each(|i| {
            self.bars[i] = EMA_ALPHA * self.bars[i] + (1.0 - EMA_ALPHA) * tmp[i];
        });

        /* 4. auto‑gain (peak‑hold with decay) */
        self.peak *= PEAK_DECAY;

        let frame_peak = self.bars.iter().copied().fold(0.0, f32::max);

        self.peak = self.peak.max(frame_peak);

        // TODO: also track min? do we even need the peak here?
        // info!("peak: {}", self.peak);

        // // scale everything from 0-1? its already scaled where 1 is full scale i think. so i don't think
        // for v in &mut self.bars {
        //     *v /= self.peak;
        // }

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
        assert_eq!(b.sec1.len(), 24);
        assert_eq!(b.sec2.len(), 24);
    }
}
