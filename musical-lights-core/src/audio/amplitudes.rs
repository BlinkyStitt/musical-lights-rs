use microfft::real::{rfft_2048, rfft_512};

use super::samples::WindowedSamples;

#[allow(unused_imports)]
use micromath::F32Ext;

/// N = number of amplitudes
/// IF N > S/2, there is an error
/// If N == S/2, there is no aggregation
/// If N < S/2,  there is aggregation
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
pub struct Amplitudes<const N: usize>(pub [f32; N]);

/// this //could// re-use the Amplitudes struct, but a dedicated type makes sure we always use the right level of processing
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
pub struct WeightedAmplitudes<const N: usize>(pub [f32; N]);

/// bin amounts summed in some way, probably exponentially
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
pub struct AggregatedAmplitudes<const N: usize>(pub [f32; N]);

pub trait AggregatedAmplitudesBuilder<const IN: usize> {
    type Output;

    // you probably want something like this
    // map: [Option<usize>; IN],

    fn build(&self, x: WeightedAmplitudes<IN>) -> Self::Output;
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
