//! Use a bank of filters for audio processing.
//!
//! This is an alternative to the code in [`BufferedFFT`].
use crate::{audio::AggregatedBins, logging::trace, remap};
use biquad::{
    Biquad, DirectForm2Transposed,
    coefficients::{Coefficients, Type},
    frequency::ToHertz,
};
use core::{array, cmp::Ordering};

#[allow(unused_imports)]
use micromath::F32Ext;

/// normally this is 24, but maybe i want to capture the highest frequencies and do 25?
const BARK_BANDS: usize = 24;

const BASS_BANDS: usize = 5;

/// combine the bottom 5 bands into a single bass band
const BARKISH_BANDS: usize = BARK_BANDS - BASS_BANDS + 1;

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
/// This is just the constants, so no licensing is required. Check out the paper though! It's really cool!
const ISO60_GAIN: [f32; BARK_BANDS] = [
    0.0891, 0.1259, 0.1585, 0.1995, 0.2985, 0.3548, 0.4217, 0.4729, 0.5311, 0.5964, 0.6309, 0.6683,
    0.7079, 0.7499, 0.7943, 0.8412, 0.8909, 0.9433, 1.0000, 1.1220, 1.2589, 1.4125, 1.6768, 2.1060,
];

/// Generic attack–release envelope.
///
/// Mostly from chat gpt.
/// Todo: should i be using <https://docs.rs/dasp_envelope>?
#[derive(Copy, Clone)]
pub struct Envelope {
    value: f32,
    attack: f32,
    release: f32,
}

type BiquadStage = DirectForm2Transposed<f32>;

/// per‑bar state (no display value here. but maybe we should have it here)
struct BandState {
    /// 1st biquad per band
    filter1: BiquadStage,
    /// 2nd biquad (identical to the first)
    filter2: BiquadStage,
    /// keep track of how loud this band has been over a medium time
    peak_env: Envelope,
    /// keep track of the quietst this band has been over a long time
    floor_env: Envelope,
    /// equal loudness countour weighting
    /// TODO: probably 60‑phon weight is the best for this, but we should think more about it
    a_coeff: f32,
    /// last raw value
    value: f32,
}

impl core::fmt::Debug for BandState {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_fmt(format_args!(
            "BandState({:.3} < {:.3} < {:.3})",
            self.floor_env.value, self.value, self.peak_env.value
        ))?;

        Ok(())
    }
}

pub struct BarkBank {
    bands: [BandState; BARK_BANDS],
}

impl BandState {
    /// `x` must be the sum of squares for all the samples divided by the number of samples in this block.
    fn run(&mut self, mut x: f32) {
        // RMS amplitude
        // apply equal loudness curve
        // Zwicker exponent for perceived loudness (TODO: i'm not sure about this. i think we want it here. we definitely want it somewhere in the pipeline)
        x = (x.sqrt() * self.a_coeff).powf(0.23);

        // TODO: should more of the above code be inside the run function? having it take the raw value makes sense to

        self.value = x;

        // TODO: think more about this max. it should probably be a value on self. and they should probably have some gap between them
        // self.peak_env.update(x.max(0.35));
        // self.floor_env.update(x.min(0.35));

        self.peak_env.update(x);
        self.floor_env.update(x);
    }
}

impl Envelope {
    pub fn new(atk_s: f32, rel_s: f32, fps: f32, init: f32) -> Self {
        let dt = 1.0 / fps;
        let attack = if atk_s <= 0.0 {
            0.0
        } else {
            (-dt / atk_s).exp()
        };
        let release = if rel_s <= 0.0 {
            0.0
        } else {
            (-dt / rel_s).exp()
        };
        Envelope {
            value: init,
            attack,
            release,
        }
    }

    #[inline]
    pub fn update(&mut self, x: f32) {
        let alpha = match x.partial_cmp(&self.value) {
            Some(Ordering::Greater) => self.attack,
            Some(Ordering::Less) => self.release,
            None | Some(Ordering::Equal) => return,
        };
        self.value = alpha * self.value + (1.0 - alpha) * x;
    }
}

impl BarkBank {
    /// Build filters for a given sample rate.
    ///
    /// TODO: some of the float math makes this not work with const
    /// TODO: result type instead of unwrap?
    pub fn new(fps_target: f32, sample_hz: f32) -> Self {
        assert!(fps_target > 0.0 && sample_hz > 0.0);

        let sample_hz = (sample_hz).hz();

        // TODO: think more about these timings
        let peak_env = Envelope::new(0.022, 3.0, fps_target, 1.0);

        // TODO: think more about these timings
        let floor_env = Envelope::new(6.0, 0.0, fps_target, 0.2);

        let bands: [BandState; BARK_BANDS] = array::from_fn(|band| {
            let (lo, hi) = (BARK_EDGES[band], BARK_EDGES[band + 1]);
            let fc = if lo > 0.0 { (lo * hi).sqrt() } else { hi * 0.5 };
            let q = (fc / (hi - lo)) * Q_BOOST;
            let c = Coefficients::from_params(Type::BandPass, sample_hz, fc.hz(), q).unwrap();

            let filter = BiquadStage::new(c);

            let a_coeff = ISO60_GAIN[band];

            BandState {
                filter1: filter.clone(),
                filter2: filter,
                peak_env: peak_env.clone(),
                floor_env: floor_env.clone(),
                a_coeff,
                value: 0.,
            }
        });

        // let map = [
        //     0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        // ];

        Self { bands }
    }

    /// TODO: can't decide if pcm should be i16 or i24 or f32
    /// Process one frame of `pcm` samples and return a fresh array of 20 normalized band outputs.
    /// 0.0 is the quietest sound heard recently. 1.0 is the loudest sound heard recently
    pub fn push_samples(&mut self, pcm: &[f32]) -> AggregatedBins<BARKISH_BANDS> {
        // 1) Accumulate raw power per analysis band (24 bands)
        let mut tmp24 = [0.0f32; BARK_BANDS];

        // TODO: can we make this a compile time check?
        debug_assert_eq!(tmp24.len(), self.bands.len());

        // do the division once. multiplication is faster on an esp32
        let inv_n = 1.0 / pcm.len() as f32;

        for (st, t) in self.bands.iter_mut().zip(tmp24.iter_mut()) {
            for &x in pcm {
                let y = st.filter2.run(st.filter1.run(x));
                *t += y * y;
            }
            *t *= inv_n;
        }

        // 2) Update all 24 peak and floor envelopes
        for (st, x) in self.bands.iter_mut().zip(tmp24.iter().copied()) {
            st.run(x);
        }

        // 3) Combine 24 → 20 outputs (first five summed as bass). Also normalize the bands so 1.0 is the loudest sound heard recently.
        let mut output = [0.0f32; BARKISH_BANDS];

        // calculate the bass band first by summing the first 5
        // TODO: is adding after we've done the powf correct? it feels wrong to me. but its just one band. come back to this later
        // TODO: calculate t,b with one iter and fold?
        // TODO: saturating sub on t or is there no chance of underflow?
        // TODO: i think a should be some value larger than 0. I'm not sure what though. possibly something different for each band similar to the equal loudness contour
        // TODO: i'm still not convinced a per-band floor is right. i think we want to subtract some fraction of the average across all bands. one loud high pitched whine making you not hear the rest seems like it matches human perception to me
        let bass_val = self.bands[0..BASS_BANDS]
            .iter()
            .map(|x| x.value)
            .sum::<f32>();

        let bass_floor = self.bands[0..BASS_BANDS]
            .iter()
            .map(|x| x.floor_env.value)
            .sum::<f32>();

        // TODO: think more about how to include the floor in here
        let bass_peak = self.bands[0..BASS_BANDS]
            .iter()
            .map(|x| x.peak_env.value)
            .sum::<f32>()
            .max(bass_floor * 2.);

        // TODO: I'm not 100% sure that the floor should be subtracted like this. i thought I could just use it for a, but that didn't work
        output[0] = remap(bass_val, bass_floor, bass_peak, 0., 1.0);

        // calculate the rest of the bands.
        for (st, out) in self.bands[BASS_BANDS..BARK_BANDS]
            .iter()
            .zip(output.iter_mut().skip(1))
        {
            let peak = st.peak_env.value.max(st.floor_env.value * 2.);

            // TODO: see todos above about the merged values. some apply here too
            *out = remap(st.value, st.floor_env.value, peak, 0.0, 1.0);
        }

        trace!("band 1: {:?}", self.bands[1]);

        AggregatedBins(output)
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
        assert_eq!(b.filter1.len(), BARK_BANDS);
        assert_eq!(b.filter2.len(), BARK_BANDS);
    }
}
