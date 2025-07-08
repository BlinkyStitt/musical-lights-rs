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

/// bin amounts summed in some way, probably exponentially.
/// TODO: rename this to SummedAmplitudes? Or do we want it to have a more generic name?
/// TODO: some people say things should be summed, but others say to take the average. then others say to calculate the RMS. And sometimes you divide by the number of bins and other times you don't. I have no idea what i'm doing.
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct AggregatedBins<const N: usize>(pub [f32; N]);

/// TODO: i am summing up bins, but i should be doing more advanced math there. either rms the power, or take the average of the amplitudes
pub trait AggregatedBinsBuilder<const IN: usize, const OUT: usize> {
    type Output;

    // // NOTE: you maybe want something like this
    // map: [Option<usize>; IN],

    /// TODO: this output should use Self::Output
    fn sum_into(&self, input: &[f32; IN], output: &mut [f32; OUT]);
}

/// TODO: From trait won't work because we need some state (the precomputed equal loudness curves)
/// TODO: do we use this anymore? if not, should we? i think this "copies" unnecessarily, but I'm not sure
impl<const B: usize> WeightedAmplitudes<B> {
    pub fn from_amplitudes(x: Amplitudes<B>, equal_loudness_curve: &[f32; B]) -> Self {
        let mut inner = x.0;

        for (x, multiplier) in inner.iter_mut().zip(equal_loudness_curve.iter()) {
            *x *= multiplier;
        }

        Self(inner)
    }
}

impl<const OUT: usize> AggregatedBins<OUT> {
    /// Sum groups of amplitudes
    ///
    /// The `map` should be something like a Bark Scale or some other exponentially increasing scale
    ///
    /// TODO: i don't think this is amplitudes anymore. cuz we are using power now
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

/// TODO: tests on this! or just delete it? i don't think we use it anymore
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

        // let bin_counts = bin_counts_from_map(&map);
        let mut output = [0.0; 2];

        AggregatedBins::sum_into(&map, &[1.0, 2.0, 4.0, 8.0, 16.0], &mut output);

        assert_eq!(output, [2.0, 12.0]);
    }
}
