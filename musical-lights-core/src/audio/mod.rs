//! Audio processing
//!
//! Samples -> Buffer -> Window -> FFT -> Amplitudes -> WeightedAmplitudes -> AggregatedAmplitudes -> Decibels -> MicLoudness
//!                                                                           (Bark, Shazam, etc.)
//!
//! TODO: bucket by note
mod amplitudes;
mod bark_scale;
mod buffer;
mod buffered_fft;
mod decibels;
mod down_resistance_builder;
mod exponential_scale;
mod fft;
mod i2s;
mod peak_scaled;
mod samples;
mod shazam;
mod weighting;

pub use amplitudes::{
    AggregatedBins, AggregatedAmplitudesBuilder, Amplitudes, WeightedAmplitudes,
};
pub use bark_scale::{BarkScaleAmplitudes, BarkScaleBuilder};
pub use buffer::AudioBuffer;
pub use buffered_fft::{BufferedFFT, FftOutputs};
pub use decibels::Decibels;
pub use down_resistance_builder::DownResistanceBuilder;
pub use exponential_scale::{ExponentialScaleAmplitudes, ExponentialScaleBuilder};
pub use fft::{FFT, bin_to_frequency, frequency_to_bin};
pub use i2s::{parse_i2s_16_bit_mono_to_f32_array, parse_i2s_24_bit_mono_to_f32_array};
pub use peak_scaled::PeakScaledBuilder;
pub use samples::{Samples, WindowedSamples};
pub use shazam::{SHAZAM_SCALE_OUT, ShazamScaleBuilder};
pub use weighting::{AWeighting, FlatWeighting, Weighting};

// TODO: test comparing bark scale and exponential scale
