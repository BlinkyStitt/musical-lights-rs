#[allow(unused_imports)]
use micromath::F32Ext;

// use crate::logging::info;

use core::borrow::Borrow;

use crate::audio::FftOutputs;

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

impl<const N: usize> Default for AggregatedBins<N> {
    fn default() -> Self {
        Self::new()
    }
}

/// TODO: I kind of wnat this to be a trait, but a trait can't have const functions
impl<const N: usize> AggregatedBins<N> {
    pub const fn new() -> Self {
        Self([0.; N])
    }
}

/// TODO: i am summing up bins, but i should be doing more advanced math there. either rms the power, or take the average of the amplitudes
pub trait AggregatedBinsBuilder<const IN: usize, const OUT: usize> {
    type Output: Default;

    /// return the inner floats of the output so they can be mutated
    fn as_inner_mut<'a>(&self, output: &'a mut Self::Output) -> &'a mut [f32; OUT];

    /// TODO: should this be a `bin` function or `bin_map`
    fn bin_map(&self) -> &[Option<usize>; IN];

    fn loudness(&self, spectrum: &FftOutputs<'_, IN>) -> Self::Output {
        let mut output = Self::Output::default();

        self.loudness_into(spectrum, &mut output);

        output
    }

    /// TODO: rename this function? should sum_power_into just be here and not as a builder in Aggregated Bins at all?
    /// TODO: use iters?
    /// TODO: this feels derivable. need to practice macros
    #[inline]
    fn loudness_into(&self, spectrum: &FftOutputs<IN>, output: &mut Self::Output) {
        let output_inner = self.as_inner_mut(output);

        self.sum_power_into(spectrum.iter_mean_square_power_density(), output_inner);

        // // TODO: convert to dbfs here?
        for x in output_inner.iter_mut() {
            let rms = x.sqrt();
            *x = 20. * rms.log10();
        }
    }

    /// TODO: hmmm. need to think more about this
    #[inline]
    fn sum_power_into<I>(&self, input_power: I, output: &mut [f32; OUT])
    where
        I: IntoIterator,
        I::Item: Borrow<f32>,
    {
        AggregatedBins::<OUT>::sum_power_into(self.bin_map(), input_power, output);
    }

    /// do setup that can't be done in a const context. defaults to a noop.
    fn init(&mut self, sample_rate_hz: f32);
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
    /// TODO: is a generic iterator on this actually what we want?
    #[inline]
    pub fn sum_power_into<const IN: usize, I>(
        map: &[Option<usize>; IN],
        input_power: I,
        output: &mut [f32; OUT],
    ) where
        I: IntoIterator,
        I::Item: Borrow<f32>,
    {
        // TODO: should we require fill be called outside this function?
        output.fill(0.0);

        for (x, &i) in input_power.into_iter().zip(map.iter()) {
            if let Some(i) = i {
                output[i] += *x.borrow();
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

/*
pub fn bin_counts_from_map<const OUT: usize>(map: &[Option<usize>]) -> [usize; OUT] {
    let mut bin_counts = [0; OUT];

    bin_counts_from_map_buf(map, &mut bin_counts);

    bin_counts
}
*/

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aggregate_into() {
        let map = [None, Some(0), Some(1), Some(1), None];

        // let bin_counts = bin_counts_from_map(&map);
        let mut output = [0.0; 2];

        AggregatedBins::sum_power_into(&map, [1.0, 2.0, 4.0, 8.0, 16.0], &mut output);

        assert_eq!(output, [2.0, 12.0]);
    }
}
