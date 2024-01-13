//! Audio processing
//!
//! Samples -> Buffer -> FFT -> Amplitudes -> WeightedAmplitudes -> AggregatedAmplitudes -> Decibels/PeakScaled
//!                                                                 (Bark, Shazam, etc.)
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

// /// TODO: i don't think we want this. it needs to be very different. definitely a different name
// pub struct DecibelBuilder<const BINS: usize, const CHANNELS: usize> {
//     /// map amplitudes to decibel bins
//     /// TODO: move this to a different struct. that way we can have shazam and bark and whatever else all from the same FFT output
//     /// Examples:
//     /// - Bark Scale splits into 24 channels from 20Hz to 15kHz
//     /// - Shazam splits into 4 channels that ignore a lot of the frequencies
//     equal_loudness_map: [Option<usize>; BINS],
// }

pub fn bin_to_frequency(bin_index: usize, sample_rate_hz: u32, num_bins: usize) -> f32 {
    (bin_index as f32) * (sample_rate_hz as f32) / ((num_bins * 2) as f32)
}

pub use amplitudes::{
    AggregatedAmplitudes, AggregatedAmplitudesBuilder, Amplitudes, WeightedAmplitudes,
};
pub use bark_scale::{BarkScaleAmplitudes, BarkScaleBuilder};
pub use buffer::AudioBuffer;
pub use decibels::Decibels;
pub use fft::FFT;
pub use peak_scaled::PeakScaled;
pub use samples::{Samples, WindowedSamples};
