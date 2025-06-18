//! Audio processing
//!
//! Samples -> Buffer -> Window -> FFT -> Amplitudes -> WeightedAmplitudes -> AggregatedAmplitudes -> Decibels/PeakScaled
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

// TODO: why does the linter think this is unused when math functions on f32 are used. something about std being enabled in the linter?
#[allow(unused_imports)]
use micromath::F32Ext;

pub use amplitudes::{
    AggregatedAmplitudes, AggregatedAmplitudesBuilder, Amplitudes, WeightedAmplitudes,
};
pub use bark_scale::{BarkScaleAmplitudes, BarkScaleBuilder};
pub use buffer::AudioBuffer;
pub use buffered_fft::{BufferedFFT, normalize_spectrum};
pub use decibels::Decibels;
pub use down_resistance_builder::DownResistanceBuilder;
pub use exponential_scale::{ExponentialScaleAmplitudes, ExponentialScaleBuilder};
pub use fft::{FFT, bin_to_frequency, frequency_to_bin};
pub use i2s::parse_i2s_24_bit_to_f32_array;
pub use peak_scaled::PeakScaledBuilder;
pub use samples::{Samples, WindowedSamples};
pub use weighting::{AWeighting, FlatWeighting, Weighting};
