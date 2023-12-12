//! TODO: bark scale?

use microfft::real::rfft_512;

/// S = number of microphone samples
pub struct Samples<const S: usize>(pub [f32; S]);

/// B = number of frequency bins. B = S/2
pub struct Amplitudes<const B: usize>(pub [f32; B]);

pub struct Decibels<const B: usize>(pub [f32; B]);

/// B = number of frequency bins. B = S/2
pub struct EqualLoudness<const B: usize>(pub [f32; B]);

impl<const S: usize, const B: usize> From<Samples<S>> for Amplitudes<B> {
    fn from(x: Samples<S>) -> Self {
        assert_eq!(S, B * 2);

        // TODO: make this work with different values of S
        assert_eq!(S, 512);

        let mut input: [f32; 512] = x.0[..S].try_into().unwrap();

        let spectrum = rfft_512(&mut input);

        // since the real-valued coefficient at the Nyquist frequency is packed into the
        // imaginary part of the DC bin, it must be cleared before computing the amplitudes
        spectrum[0].im = 0.0;

        // TODO: convert to u32? example code does
        let mut amplitudes: [f32; B] = [0.0; B];

        for (i, &spectrum) in spectrum.iter().enumerate().take(B) {
            amplitudes[i] = spectrum.norm();
        }

        Self(amplitudes)
    }
}

impl<const B: usize> Decibels<B> {
    fn from(x: Amplitudes<B>) -> Self {
        let mut inner = x.0;

        // // TODO: divide i by the reference pressure?
        // let reference_pressure = 20e-6;

        for i in inner.iter_mut() {
            *i = 20.0 * i.log10();
        }

        Self(inner)
    }
}

/// TODO: this From won't work because we need some state (the precomputed equal loudness curves)
impl<const B: usize> EqualLoudness<B> {
    fn from_decibels(x: Decibels<B>, equal_loudness_curve: [f32; B]) -> Self {
        let mut inner = x.0;

        for i in 0..B {
            inner[i] *= equal_loudness_curve[i];
        }

        Self(inner)
    }
}

pub struct AudioProcessing<const S: usize, const B: usize> {
    equal_loudness_curve: [f32; B],
}

impl<const S: usize, const B: usize> AudioProcessing<S, B> {
    pub fn new() -> Self {
        // TODO: actual equal loudness curve. maybe use bark scale?
        let equal_loudness_curve = [1.0; B];

        Self {
            equal_loudness_curve,
        }
    }

    pub fn process_samples(&self, samples: [f32; S]) -> EqualLoudness<B> {
        let samples = Samples(samples);

        let amplitudes = Amplitudes::from(samples);

        let decibels = Decibels::from(amplitudes);

        EqualLoudness::from_decibels(decibels, self.equal_loudness_curve)
    }
}

impl<const S: usize, const B: usize> Default for AudioProcessing<S, B> {
    fn default() -> Self {
        Self::new()
    }
}
