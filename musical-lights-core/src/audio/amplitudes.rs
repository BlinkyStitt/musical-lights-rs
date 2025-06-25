// #[allow(unused_imports)]
// use micromath::F32Ext;

// use crate::logging::info;

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

/// TODO: i am summing up bins, but i should be doing more advanced math there. either rms the power, or take the average of the amplitudes
pub trait AggregatedAmplitudesBuilder<const IN: usize, const OUT: usize> {
    type Output;

    // // NOTE: you maybe want something like this
    // map: [Option<usize>; IN],

    fn build(&self, input: WeightedAmplitudes<IN>) -> Self::Output;

    /// TODO: this output should use Self::Output
    fn build_into(&self, input: &[f32; IN], output: &mut [f32; OUT]);
}

/// TODO: From trait won't work because we need some state (the precomputed equal loudness curves)
/// TODO: do we use this anymore?
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
        weights: &[f32; OUT],
        input: WeightedAmplitudes<IN>,
    ) -> AggregatedAmplitudes<OUT> {
        // TODO: uninit?
        let mut output = [0.0; OUT];

        AggregatedAmplitudes::rms_into(map, weights, &input.0, &mut output);

        AggregatedAmplitudes(output)
    }

    /// TODO: give this a "rusty" name
    /// We used to just sum the bins, but that seemes wrong.
    /// Now we take average of the bins. that isn't right either though
    /// TODO: change this to do RMS of the power (input * input) with some other math
    /// TODO: i'm sure this could be made efficient. we call it a lot, so optimizations here probably matter (but compilers are smart)
    #[inline]
    pub fn rms_into<const IN: usize>(
        map: &[Option<usize>; IN],
        weight: &[f32; OUT],
        input: &[f32; IN],
        output: &mut [f32; OUT],
    ) {
        output.fill(0.0);

        // TODO: filter this efficiently?
        for (x, &i) in input.iter().zip(map.iter()) {
            // info!("adding {} to {:?}", x, i);

            if let Some(i) = i {
                output[i] += x * x;
            }
        }

        for (x, w) in output.iter_mut().zip(weight.iter()) {
            *x = (*x * w).sqrt();
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::audio::{AggregatedAmplitudes, WeightedAmplitudes};

    #[test]
    fn test_aggregate_into() {
        let map = [None, Some(0), Some(1), Some(1), None];
        let weights = [1.0, 0.5];

        let output = AggregatedAmplitudes::aggregate(
            &map,
            &weights,
            WeightedAmplitudes([1.0, 2.0, 4.0, 8.0, 16.0]),
        );

        assert_eq!(output.0, [2.0, 6.0]);
    }
}
