//! todo: better name
use super::amplitudes::{AggregatedAmplitudesBuilder, AggregatedBins};
use crate::audio::frequency_to_bin;
use crate::logging::info;

#[allow(unused_imports)]
use micromath::F32Ext;

/// TODO: do this more efficiently?
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
pub struct ExponentialScaleBuilder<const IN: usize, const OUT: usize> {
    /// index is the input id. the value is the output id. if none, the input is ignored
    /// TODO: do something fancy with ranges instead
    map: [Option<usize>; IN],
}

/// TODO: should this be a trait instead?
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct ExponentialScaleAmplitudes<const OUT: usize>(pub AggregatedBins<OUT>);

/// bins in, bands/channels out
impl<const IN: usize, const OUT: usize> ExponentialScaleBuilder<IN, OUT> {
    pub const fn uninit() -> Self {
        Self { map: [None; IN] }
    }

    /// TODO: how can we use types to be sure this init gets called
    pub fn init(&mut self, min_freq: f32, max_freq: f32, sample_rate_hz: f32) {
        assert!(
            sample_rate_hz / 2.0 >= max_freq,
            "sample rate too low. must be at least double the maximum frequency"
        );

        // always skip the very first bin. it is too noisy
        // TODO: actually the very first bin isn't noise. its the average across all bins (i think)
        let min_bin = frequency_to_bin(min_freq, sample_rate_hz, IN);

        // TODO: off by 1?
        let max_bin = frequency_to_bin(max_freq, sample_rate_hz, IN) + 1;

        // TODO: this info doesn't show on start for some reason.
        let frequency_resolution = sample_rate_hz / 2.0 / (IN as f32);
        info!("frequency resolution = {}", frequency_resolution);

        let e = find_e(OUT as u32, min_bin as u32, max_bin as u32).unwrap();
        info!("E = {}", e);

        // TODO: use end_bins instead of map? less RAM but more complicated code
        // TODO: this is big and might cause a stack overflow! need to take a buffer or refactor
        let mut end_bins = [0; OUT];

        let mut count = min_bin;
        for (b, end_bin) in end_bins.iter_mut().enumerate() {
            let n = e.powi(b as i32);

            let d = n.ceil() as usize;

            count += d;

            // TODO: is this where max_bin should be checked? we shouldn't be that far over, but we should test more if its a lot over
            *end_bin = count.min(max_bin);
        }

        // TODO: what if end_bin is < max_bin?

        let mut start_bin = min_bin;
        for (b, &end_bin) in end_bins.iter().enumerate() {
            info!("{} = bins {}..{}", b, start_bin, end_bin);

            // TODO: should take or skip be first? if we do skip then take, take needs to be the number of bins, not the final index - 1
            for x in self.map.iter_mut().take(end_bin).skip(start_bin) {
                *x = Some(b);
            }

            start_bin = end_bin;
        }
    }

    pub fn new(min_freq: f32, max_freq: f32, sample_rate_hz: f32) -> Self {
        let mut x = Self::uninit();
        x.init(min_freq, max_freq, sample_rate_hz);
        x
    }
}

impl<const IN: usize, const OUT: usize> AggregatedAmplitudesBuilder<IN, OUT>
    for ExponentialScaleBuilder<IN, OUT>
{
    type Output = ExponentialScaleAmplitudes<OUT>;

    // /// TODO: rename this function
    // fn aggregate(&self, x: WeightedAmplitudes<IN>) -> Self::Output {
    //     todo!("refactor");

    //     // let x = AggregatedAmplitudes::rms(&self.map, &self.scaling, x);

    //     // ExponentialScaleAmplitudes(x)
    // }

    /// TODO: rename this function?
    /// TODO: use iters?
    fn sum_into(&self, input: &[f32; IN], output: &mut [f32; OUT]) {
        AggregatedBins::sum_into(&self.map, input, output)
    }
}

/// Find E through brute force calculations
/// <https://forum.pjrc.com/threads/32677-Is-there-a-logarithmic-function-for-FFT-bin-selection-for-any-given-of-bands?p=133842&viewfull=1#post133842>
fn find_e(bands: u32, min_bin: u32, max_bin: u32) -> Option<f32> {
    let mut increment = 0.1;
    let mut e_test = 1.0;

    while e_test < max_bin as f32 {
        let mut count = min_bin;

        // Calculate full log values
        for b in 0..bands {
            let n = e_test.powi(b as i32);
            // round up
            let d = n.ceil() as u32;
            count += d;
        }

        match count.cmp(&max_bin) {
            core::cmp::Ordering::Greater => {
                e_test -= increment;
                increment /= 10.0;

                if increment < 0.0000001 {
                    return Some(e_test - increment);
                }
            }
            core::cmp::Ordering::Equal => {
                return Some(e_test);
            }
            core::cmp::Ordering::Less => {}
        }
        e_test += increment;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::ExponentialScaleBuilder;
    use crate::logging::info;

    /// TODO: this is old code. i'm still not positive its what a musician would recommend, but its from the teensy forums. think more about this
    #[test_log::test]
    fn test_e() {
        let small_builder = ExponentialScaleBuilder::<512, 8>::new(20.0, 20_000.0, 44_100.0);

        info!("{:?}", small_builder.map);

        let medium_builder = ExponentialScaleBuilder::<1024, 32>::new(20.0, 20_000.0, 44_100.0);

        info!("{:?}", medium_builder.map);

        panic!("actually assert things about the maps")
    }
}
