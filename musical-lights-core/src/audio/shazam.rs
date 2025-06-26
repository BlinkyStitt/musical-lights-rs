use super::amplitudes::{AggregatedAmplitudes, AggregatedAmplitudesBuilder, WeightedAmplitudes};
use crate::audio::{amplitudes::bin_counts_from_map, bin_to_frequency};

pub const SHAZAM_SCALE_OUT: usize = 4;

pub struct ShazamScaleBuilder<const FFT_OUT: usize> {
    map: [Option<usize>; FFT_OUT],
}

/// TODO: should this be a trait instead?
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct ShazamAmplitudes(pub AggregatedAmplitudes<SHAZAM_SCALE_OUT>);

impl<const FFT_OUT: usize> ShazamScaleBuilder<FFT_OUT> {
    pub const fn uninit() -> Self {
        let map = [None; FFT_OUT];

        Self { map }
    }

    /// TODO: how can we use types to be sure this init gets called
    pub fn init(&mut self, sample_rate_hz: f32) {
        // TODO: dynamically create weights (its always just 1.0 for now so no need)

        for (i, x) in self.map.iter_mut().enumerate() {
            let f = bin_to_frequency(i, sample_rate_hz, FFT_OUT);

            let b = shazam_band(f);

            // info!("{} {} = {:?}", i, f, b);

            *x = b;
        }
    }

    pub fn new(sample_rate_hz: f32) -> Self {
        let mut x = Self::uninit();
        x.init(sample_rate_hz);
        x
    }
}

impl<const IN: usize> AggregatedAmplitudesBuilder<IN, SHAZAM_SCALE_OUT> for ShazamScaleBuilder<IN> {
    type Output = ShazamAmplitudes;

    // fn mean_square_power_densisty(&self, x: WeightedAmplitudes<IN>) -> Self::Output {
    //     todo!("refactor");
    //     // let x = AggregatedAmplitudes::<SHAZAM_SCALE_OUT>::rms::<IN>(&self.map, &self.scaling, x);

    //     // ShazamAmplitudes(x)
    // }

    fn sum_into(&self, input: &[f32; IN], output: &mut [f32; SHAZAM_SCALE_OUT]) {
        AggregatedAmplitudes::sum_into(&self.map, input, output);
    }
}

/// turn a frequency into a bin for shazam
pub const fn shazam_band(f: f32) -> Option<usize> {
    match f {
        f if f < 40.0 => None,
        f if f < 80.0 => Some(0),
        f if f < 120.0 => Some(1),
        f if f < 180.0 => Some(2),
        f if f < 300.0 => Some(3),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::shazam_band;

    #[test]
    fn test_shazam_scale() {
        assert_eq!(shazam_band(-1.0), None);
        assert_eq!(shazam_band(0.0), None);
        assert_eq!(shazam_band(20.0), None);
        assert_eq!(shazam_band(40.0), Some(0));
        assert_eq!(shazam_band(79.9), Some(0));
        assert_eq!(shazam_band(80.0), Some(1));
        assert_eq!(shazam_band(119.9), Some(1));
        assert_eq!(shazam_band(120.0), Some(2));
        assert_eq!(shazam_band(179.9), Some(2));
        assert_eq!(shazam_band(180.0), Some(3));
        assert_eq!(shazam_band(299.9), Some(3));
        // TODO: i might actually want to go higher than this to get to 18 or 20kHz
        assert_eq!(shazam_band(f32::MAX), None);
    }
}
