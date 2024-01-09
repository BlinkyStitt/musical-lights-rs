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

#[macro_export]
macro_rules! impl_fft {
    ($in_size:expr) => {
        impl FFT<$in_size, { $in_size / 2 }> {
            pub fn weighted_amplitudes(
                &self,
                windowed_samples: WindowedSamples<$in_size>,
            ) -> WeightedAmplitudes<{ $in_size / 2 }> {
                let amplitudes =
                    Amplitudes::<{ $in_size / 2 }>::fft_windowed_samples(windowed_samples);

                trace!("{:?}", amplitudes);

                let weighted_amplitudes =
                    WeightedAmplitudes::from_amplitudes(amplitudes, &self.equal_loudness_curve);

                trace!("{:?}", weighted_amplitudes);

                weighted_amplitudes
            }
        }
    };
}

impl_fft!(512);
impl_fft!(2048);
