//! TODO: i don't think this is actually how shazam works
use super::amplitudes::{AggregatedBins, AggregatedBinsBuilder};
use crate::audio::{FftOutputs, bin_to_frequency};

pub const SHAZAM_SCALE_OUT: usize = 4;

pub struct ShazamScaleBuilder<const FFT_OUT: usize> {
    map: [Option<usize>; FFT_OUT],
}

/// TODO: should this be a trait instead?
#[derive(Debug, Default)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct ShazamAmplitudes(pub AggregatedBins<SHAZAM_SCALE_OUT>);

impl<const FFT_OUT: usize> ShazamScaleBuilder<FFT_OUT> {
    pub const fn uninit() -> Self {
        let map = [None; FFT_OUT];

        Self { map }
    }

    pub fn new(sample_rate_hz: f32) -> Self {
        let mut x = Self::uninit();
        x.init(sample_rate_hz);
        x
    }
}

impl<const FFT_OUT: usize> AggregatedBinsBuilder<FFT_OUT, SHAZAM_SCALE_OUT>
    for ShazamScaleBuilder<FFT_OUT>
{
    type Output = ShazamAmplitudes;

    #[inline]
    fn as_inner_mut<'a>(&self, output: &'a mut Self::Output) -> &'a mut [f32; SHAZAM_SCALE_OUT] {
        &mut output.0.0
    }

    #[inline]
    fn bin_map(&self) -> &[Option<usize>; FFT_OUT] {
        &self.map
    }

    /// TODO: how can we use types to be sure this init gets called
    fn init(&mut self, sample_rate_hz: f32) {
        // TODO: dynamically create weights (its always just 1.0 for now so no need)

        for (i, x) in self.map.iter_mut().enumerate() {
            let f = bin_to_frequency(i, sample_rate_hz, FFT_OUT);

            let b = shazam_band(f);

            // info!("{} {} = {:?}", i, f, b);

            *x = b;
        }
    }

    /// TODO: rename this function? should sum_power_into just be here and not as a builder in Aggregated Bins at all?
    #[inline]
    fn loudness_into(&self, spectrum: &FftOutputs<FFT_OUT>, output: &mut Self::Output) {
        AggregatedBins::sum_power_into(
            &self.map,
            spectrum.iter_mean_square_power_density(),
            &mut output.0.0,
        )
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
