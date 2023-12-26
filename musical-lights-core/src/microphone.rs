//! TODO: bark scale?

use apodize::hanning_iter;
use microfft::real::rfft_512;

/// S = number of microphone samples
pub struct Samples<const S: usize>(pub [f32; S]);

// TODO: add a buffer between Samples and WindowsSamples so that we can do rolling windows. re-use 50% of the samples from the previous window

pub struct WindowedSamples<const S: usize>(pub [f32; S]);

/// B = number of frequency bins. B = S/2
pub struct Amplitudes<const B: usize>(pub [f32; B]);

pub struct Decibels<const B: usize>(pub [f32; B]);

/// B = number of frequency bins. B = S/2
pub struct EqualLoudness<const B: usize>(pub [f32; B]);

impl<const S: usize> WindowedSamples<S> {
    pub fn from_samples(x: Samples<S>, multipliers: &[f32; S]) -> Self {
        // TODO: actually use the multipliers!
        let mut inner = x.0;

        for (x, multiplier) in inner.iter_mut().zip(multipliers.iter()) {
            *x *= multiplier;
        }

        Self(inner)
    }
}

impl<const S: usize, const B: usize> From<WindowedSamples<S>> for Amplitudes<B> {
    fn from(x: WindowedSamples<S>) -> Self {
        assert_eq!(S, B * 2);

        // TODO: make this work with different values of S
        assert_eq!(S, 512);

        let mut input: [f32; 512] = x.0[..S].try_into().unwrap();

        let spectrum = rfft_512(&mut input);

        // // TODO: wtf does this cargo-culted comment from the microfft example mean?
        // since the real-valued coefficient at the Nyquist frequency is packed into the
        // imaginary part of the DC bin, it must be cleared before computing the amplitudes
        spectrum[0].im = 0.0;

        // TODO: convert to u32? example code does
        let mut amplitudes: [f32; B] = [0.0; B];

        for (i, &spectrum) in spectrum.iter().enumerate().take(B) {
            // TODO: this requires std or libm!
            amplitudes[i] = spectrum.norm();
        }

        Self(amplitudes)
    }
}

impl<const B: usize> Decibels<B> {
    fn from(x: Amplitudes<B>) -> Self {
        let mut inner = x.0;

        for i in inner.iter_mut() {
            // TODO: is this right?
            *i = 20.0 * i.log10();
        }

        Self(inner)
    }
}

/// TODO: this From won't work because we need some state (the precomputed equal loudness curves)
impl<const B: usize> EqualLoudness<B> {
    fn from_decibels(x: Decibels<B>, equal_loudness_curve: [f32; B]) -> Self {
        let mut inner = x.0;

        for (x, multiplier) in inner.iter_mut().zip(equal_loudness_curve.iter()) {
            *x *= multiplier;
        }

        Self(inner)
    }
}

/// TODO: I don't think Bins is the right term. we get twice as many terms as bins?
pub struct AudioProcessing<const S: usize, const BINS: usize, const BUF: usize> {
    window_multipliers: [f32; S],
    equal_loudness_curve: [f32; BINS],
}

impl<const S: usize, const BINS: usize, const BUF: usize> AudioProcessing<S, BINS, BUF> {
    pub fn new() -> Self {
        // TODO: it currently only works with one size
        assert_eq!(S, 512);
        assert_eq!(S, BINS * 2);
        assert_eq!(BUF, S * 3 / 2);

        // TODO: allow different windows instead of hanning
        let mut window_multipliers = [0.0; S];
        for (x, multiplier) in window_multipliers.iter_mut().zip(hanning_iter(S)) {
            *x = multiplier as f32;
        }

        // TODO: actual equal loudness curve. maybe use bark scale?
        let equal_loudness_curve = [1.0; BINS];

        Self {
            window_multipliers,
            equal_loudness_curve,
        }
    }

    pub fn process_samples(&self, samples: [f32; S]) -> EqualLoudness<BINS> {
        let samples = Samples(samples);

        // TODO: add the samples to a ring buffer? that way we can do a moving window. but then this needs to be mutable... i guess we need channels?

        let windowed_samples = WindowedSamples::from_samples(samples, &self.window_multipliers);

        let amplitudes = Amplitudes::from(windowed_samples);

        // TODO: ignore a bunch of the bins?

        // println!("amplitudes = {:?}", amplitudes.0);

        let decibels = Decibels::from(amplitudes);

        // use bark scale which has 24 levels?
        EqualLoudness::from_decibels(decibels, self.equal_loudness_curve)
    }
}

impl<const S: usize, const BINS: usize, const BUF: usize> Default
    for AudioProcessing<S, BINS, BUF>
{
    fn default() -> Self {
        Self::new()
    }
}
