//! todo: better name
use super::amplitudes::{AggregatedAmplitudes, AggregatedAmplitudesBuilder, WeightedAmplitudes};
use crate::audio::{bin_to_frequency, frequency_to_bin};
use crate::logging::{error, info, trace};
use defmt::Format;
use micromath::F32Ext;

pub struct ExponentialScaleBuilder<const IN: usize, const OUT: usize> {
    map: [Option<usize>; IN],
}

/// TODO: should this be a trait instead?
#[derive(Debug, Format)]
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
        let min_bin = frequency_to_bin(min_freq, sample_rate_hz, IN).max(1);

        let max_bin = frequency_to_bin(max_freq, sample_rate_hz, IN);

        let frequency_resolution = sample_rate_hz / 2.0 / (IN as f32);
        info!("frequency resolution = {}", frequency_resolution);

        let e = find_e(OUT as u16, min_bin as u16, max_bin as u16).unwrap();
        info!("E = {}", e);

        let mut count = min_bin;

        let mut end_bins = [0; OUT];

        // TODO: save last end_bin as max_bin now instead of doing math?
        for b in 0..OUT {
            let n = e.powi(b as i32 + 1);

            // TODO: this is probably an off-by-one error
            let d = n.ceil() as usize;

            end_bins[b] = count;

            count += d as usize;
        }

        let mut start_bin = min_bin;
        for (b, &end_bin) in end_bins.iter().enumerate() {
            for x in start_bin..=end_bin {
                map[x] = Some(b);
            }

            start_bin = end_bin + 1;
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
fn find_e(bands: u16, min_bin: u16, max_bin: u16) -> Option<f32> {
    let mut increment = 0.1;
    let mut e_test = 1.0;

    while e_test < max_bin as f32 {
        let mut count = min_bin;

        // Calculate full log values
        for b in 0..bands {
            let n = e_test.powi(b as i32);
            // round up
            let d = n.ceil() as u16;
            count += d;
        }

        if count > max_bin {
            e_test -= increment;
            increment /= 10.0;

            if increment < 0.0000001 {
                return Some(e_test - increment);
            }
        } else if count == max_bin {
            return Some(e_test);
        }

        e_test += increment;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::ExponentialScaleBuilder;

    #[test_log::test]
    fn test_e() {
        let builder = ExponentialScaleBuilder::<1024, 16>::new(20.0, 20_000.0, 44_100.0);

        panic!("{:?}", builder.map);
    }
}
