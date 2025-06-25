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
    /// TODO: i don't like this function being here. feels like it should be in the builder instead
    pub fn rms<const IN: usize>(
        map: &[Option<usize>; IN],
        scaling: &[(f32, f32); OUT],
        input: WeightedAmplitudes<IN>,
    ) -> AggregatedAmplitudes<OUT> {
        // TODO: uninit?
        let mut output = [0.0; OUT];

        AggregatedAmplitudes::rms_into(map, scaling, &input.0, &mut output);

        AggregatedAmplitudes(output)
    }

    /// TODO: give this a "rusty" name
    /// We used to just sum the bins, but that seemes wrong.
    /// Now we take average of the bins. that isn't right either though
    /// TODO: change this to do RMS of the power (input * input) with some other math
    /// TODO: i'm sure this could be made efficient. we call it a lot, so optimizations here probably matter (but compilers are smart)
    /// TODO: i don't like the name of "scaling". its (1/bins_per_output, sqrt(bins_per_output))
    /// TODO: i don't like this function being here. feels like it should be in the builder instead
    #[inline]
    pub fn rms_into<const IN: usize>(
        map: &[Option<usize>; IN],
        scaling: &[(f32, f32); OUT],
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

        // at this point, output is the sum of the squares of the inputs. it needs some scaling still
        for (x, (s_inv, s_sqrt)) in output.iter_mut().zip(scaling.iter()) {
            // TODO: sqrt for RMS-amplitude. Otherwise it's power (I think? Which do we want)
            // then we multiple it by the sqrt
            *x = (*x * *s_inv).sqrt() * s_sqrt;
        }
    }
}

/// TODO: tests on this!
/// TODO: can this be made const?
pub fn scaling_from_bin_map<const OUT: usize>(map: &[Option<usize>]) -> [(f32, f32); OUT] {
    let mut output: [(f32, f32); OUT] = [(0.0, 0.0); OUT];
    for i in map.iter().copied().flatten() {
        output[i].0 += 1.0;
    }

    // at this point, output.0 is the count of bins in each band

    for (scale_inv, scale_sqrt) in output.iter_mut() {
        let bin_count = *scale_inv;

        *scale_inv = 1.0 / bin_count;
        // TODO: is an approx sqrt fine?
        *scale_sqrt = bin_count.sqrt();
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aggregate_into() {
        let map = [None, Some(0), Some(1), Some(1), None];

        let scaling = scaling_from_bin_map(&map);

        let output = AggregatedAmplitudes::rms(
            &map,
            &scaling,
            WeightedAmplitudes([1.0, 2.0, 4.0, 8.0, 16.0]),
        );

        assert_eq!(output.0, [2.0, 6.0]);
    }
}
