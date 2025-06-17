//! todo: better name
use super::amplitudes::{AggregatedAmplitudes, AggregatedAmplitudesBuilder, WeightedAmplitudes};
use crate::audio::frequency_to_bin;
use crate::logging::info;

#[allow(unused_imports)]
use micromath::F32Ext;

/// TODO: do this more efficiently?
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
pub struct ExponentialScaleBuilder<const IN: usize, const OUT: usize> {
    map: [Option<usize>; IN],
}

/// TODO: should this be a trait instead?
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct ExponentialScaleAmplitudes<const OUT: usize>(pub AggregatedAmplitudes<OUT>);

/// bins in, bands/channels out
impl<const IN: usize, const OUT: usize> ExponentialScaleBuilder<IN, OUT> {
    pub fn new(min_freq: f32, max_freq: f32, sample_rate_hz: f32) -> Self {
        let mut map = [None; IN];

        debug_assert!(
            sample_rate_hz / 2.0 >= max_freq,
            "sample rate too low. must be at least double the maximum frequency"
        );

        // always skip the very first bin. it is too noisy
        let min_bin = frequency_to_bin(min_freq, sample_rate_hz, IN);

        // TODO: off by 1?
        let max_bin = frequency_to_bin(max_freq, sample_rate_hz, IN) + 1;

        let frequency_resolution = sample_rate_hz / 2.0 / (IN as f32);
        info!("frequency resolution = {}", frequency_resolution);

        let e = find_e(OUT as u32, min_bin as u32, max_bin as u32).unwrap();
        info!("E = {}", e);

        // TODO: use end_bins instead of map? less RAM but more complicated code
        let mut end_bins = [0; OUT];

        let mut count = min_bin;
        for (b, end_bin) in end_bins.iter_mut().enumerate() {
            let n = e.powi(b as i32);

            let d = n.ceil() as usize;

            count += d;

            // TODO: is there where max_bin should be checked? we shouldn't be that far over, but we should test more if its a lot over
            *end_bin = count.min(max_bin);
        }

        // TODO: what if end_bin is < max_bin?

        let mut start_bin = min_bin;
        for (b, &end_bin) in end_bins.iter().enumerate() {
            for x in map.iter_mut().take(end_bin).skip(start_bin) {
                *x = Some(b);
            }

            start_bin = end_bin;
        }

        Self { map }
    }
}

impl<const IN: usize, const OUT: usize> AggregatedAmplitudesBuilder<IN>
    for ExponentialScaleBuilder<IN, OUT>
{
    type Output = ExponentialScaleAmplitudes<OUT>;

    fn build(&self, x: WeightedAmplitudes<IN>) -> Self::Output {
        let x = AggregatedAmplitudes::aggregate(&self.map, x);

        ExponentialScaleAmplitudes(x)
    }
}

/// Find E through brute force calculations
/// <https://forum.pjrc.com/threads/32677-Is-there-a-logarithmic-function-for-FFT-bin-selection-for-any-given-of-bands?p=133842&viewfull=1#post133842>
/// TODO: this is giving too large of values. something went wrong
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
