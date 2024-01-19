//! Audio processing
//!
//! Samples -> Buffer -> Window -> FFT -> Amplitudes -> WeightedAmplitudes -> AggregatedAmplitudes -> Decibels/PeakScaled
//!                                                                           (Bark, Shazam, etc.)
mod amplitudes;
mod bark_scale;
mod buffer;
mod decibels;
mod exponential_scale;
mod fft;
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
pub use decibels::Decibels;
pub use exponential_scale::{ExponentialScaleAmplitudes, ExponentialScaleBuilder};
pub use fft::{bin_to_frequency, frequency_to_bin, FFT};
pub use peak_scaled::PeakScaled;
pub use samples::{Samples, WindowedSamples};
pub use weighting::{AWeighting, FlatWeighting, Weighting};
