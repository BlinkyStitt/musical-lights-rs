use defmt::Format;
use microfft::real::{rfft_2048, rfft_512};

use super::samples::WindowedSamples;

#[allow(unused_imports)]
use micromath::F32Ext;

/// N = number of amplitudes
/// IF N > S/2, there is an error
/// If N == S/2, there is no aggregation
/// If N < S/2,  there is aggregation
#[derive(Debug, Format)]
pub struct Amplitudes<const N: usize>(pub [f32; N]);

/// this //could// re-use the Amplitudes struct, but a dedicated type makes sure we always use the right level of processing
#[derive(Debug, Format)]
pub struct WeightedAmplitudes<const N: usize>(pub [f32; N]);

///  bin amounts scale exponentially
#[derive(Debug, Format)]
pub struct AggregatedAmplitudes<const N: usize>(pub [f32; N]);

pub trait AggregatedAmplitudesBuilder<const IN: usize> {
    type Output;

    // you probably want something like this
    // map: [Option<usize>; IN],

    fn build(&self, x: WeightedAmplitudes<IN>) -> Self::Output;
}

// TODO: this should use a macro. should this use the standard From trait?
impl Amplitudes<1024> {
    pub fn fft_windowed_samples(x: WindowedSamples<2048>) -> Self {
        let mut fft_input = x.0;

        let fft_output = rfft_2048(&mut fft_input);

        fft_output[0].im = 0.0;

        let mut amplitudes: [f32; 1024] = [0.0; 1024];

        for (x, &spectrum) in amplitudes.iter_mut().zip(fft_output.iter()) {
            #[cfg(feature = "std")]
            {
                *x = spectrum.norm();
            }

            #[cfg(not(feature = "std"))]
            {
                *x = (spectrum.re * spectrum.re + spectrum.im * spectrum.im).sqrt();
            }
        }

        Self(amplitudes)
    }
}

impl Amplitudes<256> {
    /// TODO: this does not seem efficient. match and generics feel wrong. but i don't control the types on rfft_*. they require 256, 1024, etc. but we have B and S
    pub fn fft_windowed_samples(x: WindowedSamples<512>) -> Self {
        let mut fft_input = x.0;

        let fft_output = rfft_512(&mut fft_input);

        fft_output[0].im = 0.0;

        let mut amplitudes = [0.0f32; 256];

        for (x, &spectrum) in amplitudes.iter_mut().zip(fft_output.iter()) {
            #[cfg(feature = "std")]
            {
                *x = spectrum.norm();
            }

            #[cfg(not(feature = "std"))]
            {
                *x = (spectrum.re * spectrum.re + spectrum.im * spectrum.im).sqrt();
            }
        }

        Self(amplitudes)
    }
}

/// TODO: From trait won't work because we need some state (the precomputed equal loudness curves)
impl<const B: usize> WeightedAmplitudes<B> {
    pub fn from_amplitudes(x: Amplitudes<B>, equal_loudness_curve: &[f32; B]) -> Self {
        let mut inner = x.0;

        for (x, multiplier) in inner.iter_mut().zip(equal_loudness_curve.iter()) {
            *x *= multiplier;
        }

        Self(inner)
    }
}

impl<const N: usize> AggregatedAmplitudes<N> {
    pub fn aggregate<const IN: usize>(
        map: &[Option<usize>; IN],
        x: WeightedAmplitudes<IN>,
    ) -> AggregatedAmplitudes<N> {
        let mut output = [0.0; N];

        let input = x.0;

        for (x, &i) in input.iter().zip(map.iter()) {
            if let Some(i) = i {
                output[i] += x;
            }
        }

        AggregatedAmplitudes(output)
    }
}
