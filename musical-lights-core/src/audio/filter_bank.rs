//! Use a bank of filters for audio processing.
//!
//! An alternative to the code in [`BufferedFFT`].
//!
//! My original design (inspired by things built with a Teensy Audio Board) used an FFT.
//!
use biquad::{
    Biquad, DirectForm2Transposed,
    coefficients::{Coefficients, Type},
    frequency::ToHertz,
};
// use static_cell::{ConstStaticCell, StaticCell};

#[cfg(not(any(feature = "std", feature = "libm")))]
use micromath::F32Ext;

/*─────────────────────────── Tables ────────────────────────────*/

/// Zwicker / Traunmüller Bark band edges (Hz).
const BARK_EDGES: [f32; 25] = [
    0.0, 100.0, 200.0, 300.0, 400.0, 510.0, 630.0, 770.0, 920.0, 1080.0, 1270.0, 1480.0, 1720.0,
    2000.0, 2320.0, 2700.0, 3150.0, 3700.0, 4400.0, 5300.0, 6400.0, 7700.0, 9500.0, 12_000.0,
    15_500.0,
];

/// Inverse 60‑phon equal‑loudness gains (ISO‑226 2023, smoothed).
///
/// TODO: this is just from an LLM. check the math
const ISO60_GAIN: [f32; 24] = [
    0.0891, 0.1259, 0.1585, 0.1995, 0.2985, 0.3548, 0.4217, 0.4729, 0.5311, 0.5964, 0.6309, 0.6683,
    0.7079, 0.7499, 0.7943, 0.8412, 0.8909, 0.9433, 1.0000, 1.1220, 1.2589, 1.4125, 1.6768, 2.1060,
];

/*──────────────────── Filter‑bank Struct ───────────────────────*/

/// 24‑band Bark filter‑bank (Direct‑Form II Transposed biquads).
pub struct BarkBank {
    filters: [DirectForm2Transposed<f32>; 24],
}

impl BarkBank {
    /// Build filters for `sr_hz`.
    pub fn new(sr_hz: f32) -> Self {
        let fs = (sr_hz).hz();
        let dummy = DirectForm2Transposed::<f32>::new(
            Coefficients::from_params(Type::BandPass, fs, 1_000.0.hz(), 1.0).unwrap(),
        );
        let mut filters = [dummy; 24];

        for (i, f) in filters.iter_mut().enumerate() {
            let (lo, hi) = (BARK_EDGES[i], BARK_EDGES[i + 1]);
            let fc = if lo > 0.0 { (lo * hi).sqrt() } else { hi * 0.5 };
            let q = (fc / (hi - lo)).max(0.1);
            let c = Coefficients::from_params(Type::BandPass, fs, fc.hz(), q).unwrap();
            f.update_coefficients(c);
        }
        Self { filters }
    }

    /// Mean power per Bark band from `pcm`; writes into `dst`.
    /// TODO: can't decide if pcm should be i16 or i24 or f32
    pub fn power_block_into(&mut self, pcm: &[f32], dst: &mut [f32; 24], scale: f32) {
        dst.fill(0.0);
        for &s in pcm {
            let x = s * scale;
            for (k, f) in self.filters.iter_mut().enumerate() {
                let y = f.run(x);
                dst[k] += y * y;
            }
        }
        let norm = 1.0 / pcm.len() as f32;
        for v in dst.iter_mut() {
            *v *= norm;
        }
    }
}

/// TODO: document this more. whats the powf doing?
#[inline(always)]
pub fn loudness_in_place(buf: &mut [f32; 24]) {
    for (b, g) in buf.iter_mut().zip(ISO60_GAIN) {
        *b = (*b * g).powf(0.33);
    }
}

/// TODO: document this better. do we need it to be const? probably not
#[inline(always)]
pub fn ema_in_place<const N: usize>(buf: &mut [f32; N], state: &mut [f32; N], alpha: f32) {
    for (x, e) in buf.iter_mut().zip(state.iter_mut()) {
        *e = alpha * *e + (1.0 - alpha) * *x;
        *x = *e;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn filterbank_len() {
        let b = BarkBank::new(48_000.);
        assert_eq!(b.filters.len(), 24);
    }
}
