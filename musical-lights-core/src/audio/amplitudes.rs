#[allow(unused_imports)]
use micromath::F32Ext;

/// N = number of amplitudes
/// IF N > S/2, there is an error
/// If N == S/2, there is no aggregation
/// If N < S/2,  there is aggregation
/// TODO: do we definitely want f32?
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct Amplitudes<const N: usize>(pub [f32; N]);

/// this //could// re-use the Amplitudes struct, but a dedicated type makes sure we always use the right level of processing
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct WeightedAmplitudes<const N: usize>(pub [f32; N]);

/// bin amounts summed in some way, probably exponentially
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct AggregatedAmplitudes<const N: usize>(pub [f32; N]);

pub trait AggregatedAmplitudesBuilder<const IN: usize, const OUT: usize> {
    type Output;

    // // NOTE: you maybe want something like this
    // map: [Option<usize>; IN],

    fn build(&self, input: WeightedAmplitudes<IN>) -> Self::Output;

    fn build_into(&self, input: &[f32; IN], output: &mut [f32; OUT]);
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

impl<const OUT: usize> AggregatedAmplitudes<OUT> {
    pub fn aggregate<const IN: usize>(
        map: &[Option<usize>; IN],
        input: WeightedAmplitudes<IN>,
    ) -> AggregatedAmplitudes<OUT> {
        // TODO: uninit?
        let mut output = [0.0; OUT];

        AggregatedAmplitudes::aggregate_into(map, &input.0, &mut output);

        AggregatedAmplitudes(output)
    }

    #[inline]
    pub fn aggregate_into<const IN: usize>(
        map: &[Option<usize>; IN],
        input: &[f32; IN],
        output: &mut [f32; OUT],
    ) {
        // TODO: we don't need to do this always
        output.fill(0.0);

        for (x, &i) in input.iter().zip(map.iter()) {
            if let Some(i) = i {
                output[i] += x;
            }
        }
    }
}
