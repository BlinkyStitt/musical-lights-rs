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

    /// TODO: write a default implementation on this
    // fn mean_square_power_densisty(&self, input: WeightedAmplitudes<IN>) -> Self::Output;

    /// TODO: this output should use Self::Output
    fn sum_into(&self, input: &[f32; IN], output: &mut [f32; OUT]);
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

/// TODO: i don't think this is amplitudes anymore. cuz we are using power now
impl<const OUT: usize> AggregatedAmplitudes<OUT> {
    /// Convert each bin to mean-square power density. Square the magnitude and divide by N² to match Parseval’s theorem.
    ///
    /// TODO: give this a "rusty" name. i don't think this is very rusty though. think more about refactoring it once more of it works
    /// We used to just sum the bins, but that seemes wrong.
    /// Now we take average of the bins. that isn't right either though
    /// TODO: change this to do RMS of the power (input * input) with some other math
    /// TODO: i'm sure this could be made efficient. we call it a lot, so optimizations here probably matter (but compilers are smart)
    /// TODO: i don't like this function being here. feels like it should be in the builder instead
    /// TODO: should input_power be an iterator?
    /// TODO: should this just take the FftOutput as the main argument?
    #[inline]
    pub fn sum_into<const IN: usize>(
        map: &[Option<usize>; IN],
        input_power: &[f32; IN],
        output_power: &mut [f32; OUT],
    ) {
        // TODO: should we require fill be called outside this function?
        output_power.fill(0.0);

        for (x, &i) in input_power.iter().zip(map.iter()) {
            if let Some(i) = i {
                output_power[i] += x;
            }
        }
    }
}

/// TODO: tests on this!
/// TODO: can this be made const?
/// TODO: whats a better name for this? _buf? _in_place? _into?
pub fn bin_counts_from_map_buf<const OUT: usize>(map: &[Option<usize>], counts: &mut [usize; OUT]) {
    for i in map.iter().copied().flatten() {
        counts[i] += 1;
    }
}

pub fn bin_counts_from_map<const OUT: usize>(map: &[Option<usize>]) -> [usize; OUT] {
    let mut bin_counts = [0; OUT];

    bin_counts_from_map_buf(map, &mut bin_counts);

    bin_counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aggregate_into() {
        let map = [None, Some(0), Some(1), Some(1), None];

        let bin_counts = bin_counts_from_map(&map);
        let mut output = [0.0; 2];

        AggregatedAmplitudes::sum_into(&map, &[1.0, 2.0, 4.0, 8.0, 16.0], &mut output);

        assert_eq!(output, [2.0, 6.0]);
    }
}
