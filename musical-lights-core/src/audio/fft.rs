use super::{
    FlatWeighting,
    amplitudes::WeightedAmplitudes,
    samples::{Samples, WindowedSamples},
    weighting::Weighting,
};
use crate::logging::trace;
use crate::{audio::amplitudes::Amplitudes, windows::Window};

use microfft::real::{rfft_512, rfft_1024, rfft_2048, rfft_4096};
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

    pub fn new_with_window<WI: Window<IN>>() -> Self {
        let weighting = FlatWeighting;

        Self::new_with_window_and_weighting::<WI, _>(weighting)
    }

    pub fn new_with_window_and_weighting<WI: Window<IN>, WE: Weighting<OUT>>(
        weighting: WE,
    ) -> Self {
        let window_multipliers = WI::windows();

        let window_scaling = WI::scaling();

        let mut equal_loudness_curve = weighting.curve();

        for x in equal_loudness_curve.iter_mut() {
            *x *= window_scaling;
        }

        Self::new(window_multipliers, equal_loudness_curve)
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
    ($in_size:expr, $fft_func:ident) => {
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

        impl Amplitudes<{ $in_size / 2 }> {
            pub fn fft_windowed_samples(x: WindowedSamples<$in_size>) -> Self {
                let mut fft_input = x.0;

                let fft_output = $fft_func(&mut fft_input);

                // TODO: i think we want to ignore the first bin entirely
                // fft_output[0].re = 0.0;
                // TODO: document why we do this. something about this having the max amplitude and being a DC offset?
                fft_output[0].im = 0.0;

                let mut amplitudes: [f32; { $in_size / 2 }] = [0.0; { $in_size / 2 }];

                for (x, &spectrum) in amplitudes.iter_mut().zip(fft_output.iter()) {
                    *x = spectrum.norm();
                }

                Self(amplitudes)
            }
        }
    };
}

impl_fft!(512, rfft_512);
impl_fft!(1024, rfft_1024);
impl_fft!(2048, rfft_2048);
impl_fft!(4096, rfft_4096);

pub fn bin_to_frequency(bin_index: usize, sample_rate_hz: f32, num_bins: usize) -> f32 {
    (bin_index as f32) * sample_rate_hz / ((num_bins * 2) as f32)
}

pub fn frequency_to_bin(frequency: f32, sample_rate_hz: f32, num_bins: usize) -> usize {
    ((frequency * (num_bins * 2) as f32) / sample_rate_hz).round() as usize
}
