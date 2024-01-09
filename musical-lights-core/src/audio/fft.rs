use super::{amplitudes::WeightedAmplitudes, samples::WindowedSamples};
use crate::audio::amplitudes::Amplitudes;
use crate::logging::trace;

// TODO: why does the linter think this is unused when math functions on f32 are used. something about std being enabled in the linter?
#[allow(unused_imports)]
use micromath::F32Ext;

pub struct FFT<const IN: usize, const OUT: usize> {
    /// apply this curve to amplitudes after the FFT calculates them
    equal_loudness_curve: [f32; OUT],
}

impl<const IN: usize, const OUT: usize> Default for FFT<IN, OUT> {
    fn default() -> Self {
        // TODO: compile time assert
        debug_assert_eq!(IN / 2, OUT);

        // TODO: a weighting or any other curve. will need to move this to the "new" method then
        let equal_loudness_curve = [1.0; OUT];

        Self {
            equal_loudness_curve,
        }
    }
}

/// TODO: macro for this?
impl FFT<512, 256> {
    pub fn weighted_amplitudes(
        &self,
        windowed_samples: WindowedSamples<512>,
    ) -> WeightedAmplitudes<256> {
        let amplitudes = Amplitudes::<256>::from_windowed_samples(windowed_samples);

        trace!("{:?}", amplitudes);

        let weighted_amplitudes =
            WeightedAmplitudes::from_amplitudes(amplitudes, &self.equal_loudness_curve);

        trace!("{:?}", weighted_amplitudes);

        weighted_amplitudes
    }
}

impl FFT<2048, 1024> {
    pub fn weighted_amplitudes(
        &self,
        windowed_samples: WindowedSamples<2048>,
    ) -> WeightedAmplitudes<1024> {
        let amplitudes = Amplitudes::<1024>::from_windowed_samples(windowed_samples);

        trace!("{:?}", amplitudes);

        let weighted_amplitudes =
            WeightedAmplitudes::from_amplitudes(amplitudes, &self.equal_loudness_curve);

        trace!("{:?}", weighted_amplitudes);

        weighted_amplitudes
    }
}
