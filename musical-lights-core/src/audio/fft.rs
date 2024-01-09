use super::{
    amplitudes::WeightedAmplitudes,
    samples::{Samples, WindowedSamples},
};
use crate::audio::amplitudes::Amplitudes;
use crate::logging::trace;

// TODO: why does the linter think this is unused when math functions on f32 are used. something about std being enabled in the linter?
#[allow(unused_imports)]
use micromath::F32Ext;

pub struct FFT<const IN: usize, const OUT: usize> {
    /// apply a window to the samples before processing them with the FFT
    /// hanning window or similar things can be applied with this
    window_multipliers: [f32; IN],

    /// apply this curve to amplitudes after the FFT calculates them
    /// a-weighting or similra things can be applied with this
    equal_loudness_curve: [f32; OUT],
}

impl<const IN: usize, const OUT: usize> FFT<IN, OUT> {
    pub fn new(window_multipliers: [f32; IN], equal_loudness_curve: [f32; OUT]) -> Self {
        // TODO: compile time assert
        debug_assert_eq!(IN / 2, OUT);

        Self {
            window_multipliers,
            equal_loudness_curve,
        }
    }
}

impl<const IN: usize, const OUT: usize> Default for FFT<IN, OUT> {
    fn default() -> Self {
        let window_multipliers = [1.0; IN];

        let equal_loudness_curve = [1.0; OUT];

        Self::new(window_multipliers, equal_loudness_curve)
    }
}

#[macro_export]
macro_rules! impl_fft {
    ($in_size:expr) => {
        impl FFT<$in_size, { $in_size / 2 }> {
            /// a windowed and weighted FFT
            pub fn weighted_amplitudes(
                &self,
                samples: Samples<$in_size>,
            ) -> WeightedAmplitudes<{ $in_size / 2 }> {
                let windowed_samples =
                    WindowedSamples::from_samples(samples, &self.window_multipliers);

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
