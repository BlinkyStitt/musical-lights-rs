//! todo: better name
use crate::audio::bin_to_frequency;

use super::amplitudes::{AggregatedAmplitudes, AggregatedAmplitudesBuilder, WeightedAmplitudes};
use defmt::Format;

pub struct ExponentialScaleBuilder<const IN: usize> {
    map: [Option<usize>; IN],
}

/// TODO: should this be a trait instead?
#[derive(Debug, Format)]
pub struct ExponentialScaleAmplitudes(pub AggregatedAmplitudes<24>);

impl<const BINS: usize> ExponentialScaleBuilder<BINS> {
    pub fn new(sample_rate_hz: u32) -> Self {
        let mut map = [Some(0); BINS];
        for (i, x) in map.iter_mut().enumerate() {
            let b = exponential_scale(i, 20.0, sample_rate_hz / 2, BINS);

            *x = b;
        }

        Self { map }
    }
}

impl<const IN: usize> AggregatedAmplitudesBuilder<IN> for ExponentialScaleBuilder<IN> {
    type Output = ExponentialScaleAmplitudes;

    fn build(&self, x: WeightedAmplitudes<IN>) -> Self::Output {
        let x = AggregatedAmplitudes::aggregate(&self.map, x);

        ExponentialScaleAmplitudes(x)
    }
}

/// turn a frequency into a channel where each channel covers more frequencies than the last
pub fn exponential_scale(bin: u8, min_freq: f32, max_freq: f32, num_bins: u8) -> Option<usize> {
    let f = bin_to_frequency(i, sample_rate_hz, BINS);

    // trace!("{} {} = {:?}", i, f, b);
    error!("actually calculate exponential scale!");

    Some(0)
}

#[cfg(test)]
mod tests {
    use super::bark_scale;

    #[test]
    fn test_bark_scale() {
        assert_eq!(bark_scale(-1.0), None);
        assert_eq!(bark_scale(0.0), None);
        assert_eq!(bark_scale(20.0), Some(1));
        assert_eq!(bark_scale(50.0), Some(1));
        assert_eq!(bark_scale(100.0), Some(1));
        assert_eq!(bark_scale(150.0), Some(2));
        assert_eq!(bark_scale(200.0), Some(2));
        assert_eq!(bark_scale(250.0), Some(3));
        assert_eq!(bark_scale(300.0), Some(3));
        assert_eq!(bark_scale(350.0), Some(4));
        assert_eq!(bark_scale(400.0), Some(4));
        assert_eq!(bark_scale(450.0), Some(5));
        assert_eq!(bark_scale(510.0), Some(5));
        assert_eq!(bark_scale(570.0), Some(6));
        assert_eq!(bark_scale(630.0), Some(6));
        assert_eq!(bark_scale(700.0), Some(7));
        assert_eq!(bark_scale(770.0), Some(7));
        assert_eq!(bark_scale(840.0), Some(8));
        assert_eq!(bark_scale(920.0), Some(8));
        assert_eq!(bark_scale(1000.0), Some(9));
        assert_eq!(bark_scale(1080.0), Some(9));
        assert_eq!(bark_scale(1170.0), Some(10));
        assert_eq!(bark_scale(1270.0), Some(10));
        assert_eq!(bark_scale(1370.0), Some(11));
        assert_eq!(bark_scale(1480.0), Some(11));
        assert_eq!(bark_scale(1600.0), Some(12));
        assert_eq!(bark_scale(1720.0), Some(12));
        assert_eq!(bark_scale(1850.0), Some(13));
        assert_eq!(bark_scale(2000.0), Some(13));
        assert_eq!(bark_scale(2150.0), Some(14));
        assert_eq!(bark_scale(2320.0), Some(14));
        assert_eq!(bark_scale(2500.0), Some(15));
        assert_eq!(bark_scale(2700.0), Some(15));
        assert_eq!(bark_scale(2900.0), Some(16));
        assert_eq!(bark_scale(3150.0), Some(16));
        assert_eq!(bark_scale(3400.0), Some(17));
        assert_eq!(bark_scale(3700.0), Some(17));
        assert_eq!(bark_scale(4000.0), Some(18));
        assert_eq!(bark_scale(4400.0), Some(18));
        assert_eq!(bark_scale(4800.0), Some(19));
        assert_eq!(bark_scale(5300.0), Some(19));
        assert_eq!(bark_scale(5800.0), Some(20));
        assert_eq!(bark_scale(6400.0), Some(20));
        assert_eq!(bark_scale(7000.0), Some(21));
        assert_eq!(bark_scale(7700.0), Some(21));
        assert_eq!(bark_scale(8500.0), Some(22));
        assert_eq!(bark_scale(9500.0), Some(22));
        assert_eq!(bark_scale(10500.0), Some(23));
        assert_eq!(bark_scale(12000.0), Some(23));
        assert_eq!(bark_scale(13500.0), Some(24));
        assert_eq!(bark_scale(15500.0), Some(24));
        assert_eq!(bark_scale(16000.0), None); // Beyond the Bark scale
                                               // TODO: i might actually want to go higher than this to get to 18 or 20kHz
        assert_eq!(bark_scale(f32::MAX), None);
    }
}
