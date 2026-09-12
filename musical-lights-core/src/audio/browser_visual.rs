//! 240 loudness samples across the 24-Bark scale, spaced at 0.1 Bark.
//! These sample the model's loudness curve, not independent auditory channels.
//! Hardware and balloon physics retain 24 aggregate bands.
use super::{
    loudness::{LoudnessFrame, SPECIFIC_BINS},
    visual::{
        BARK_EDGES, BandLevel, DISPLAY_BANDS, DisplayFrame, DisplaySnapshot, VisualGain, compress,
    },
};
use crate::lights::Gradient;
use palette::LinSrgb;

pub const BROWSER_SLICES: usize = SPECIFIC_BINS;
pub const SLICES_PER_GROUP: usize = BROWSER_SLICES / DISPLAY_BANDS;
const SLICE_BARK_WIDTH: f64 = 1.0 / SLICES_PER_GROUP as f64;

pub struct BrowserLevels {
    pub slices: [BandLevel; BROWSER_SLICES],
    pub bands: [BandLevel; DISPLAY_BANDS],
}

impl VisualGain {
    pub fn map_browser(&mut self, frame: &LoudnessFrame) -> BrowserLevels {
        // Advance gain exactly once, using the unchanged aggregate contract.
        let (aggregate, gain) = self.map_with_gain(frame);
        BrowserLevels {
            bands: aggregate.bands,
            slices: frame.specific_sones_per_bark.map(|density| BandLevel {
                // Display density on one shared scale. The 1.25 headroom
                // maps gain*density=4 to full height; it is not loudness.
                activity: (1.25 * compress(gain, density as f32).activity).min(1.0),
                sones: (density * SLICE_BARK_WIDTH) as f32,
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BrowserFrame {
    pub slices: [f32; BROWSER_SLICES],
    pub group_heights: [f32; DISPLAY_BANDS],
    /// Aggregate activity and attack edges also drive the balloon world.
    pub bands: DisplayFrame<DISPLAY_BANDS>,
}

impl Default for BrowserFrame {
    fn default() -> Self {
        Self {
            slices: [0.0; BROWSER_SLICES],
            group_heights: [0.0; DISPLAY_BANDS],
            bands: DisplayFrame::default(),
        }
    }
}

/// One message carries both resolutions on the same audio clock. Each slice
/// retains its own fall. One aggregate acoustic attack controls each group edge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BrowserSnapshot {
    bands: DisplaySnapshot<DISPLAY_BANDS>,
    slices: DisplaySnapshot<BROWSER_SLICES>,
}

impl BrowserSnapshot {
    const BAND_TRANSPORT_LEN: usize = DisplaySnapshot::<DISPLAY_BANDS>::TRANSPORT_LEN;
    pub const TRANSPORT_LEN: usize =
        Self::BAND_TRANSPORT_LEN + DisplaySnapshot::<BROWSER_SLICES>::TRANSPORT_LEN;

    pub fn new(at: f64) -> Self {
        Self {
            bands: DisplaySnapshot::new(at),
            slices: DisplaySnapshot::new(at),
        }
    }

    pub fn timestamp(&self) -> f64 {
        self.bands.timestamp()
    }

    pub fn push(&mut self, at: f64, values: BrowserLevels, reduced_motion: bool) {
        self.bands.push(at, values.bands, reduced_motion);
        self.slices.push(at, values.slices, reduced_motion);
    }

    pub fn frame(&self, at: f64) -> BrowserFrame {
        let slices = self.slices.frame(at).levels;
        BrowserFrame {
            group_heights: core::array::from_fn(|group| {
                slices[group * SLICES_PER_GROUP..(group + 1) * SLICES_PER_GROUP]
                    .iter()
                    .copied()
                    .fold(0.0, f32::max)
            }),
            slices,
            bands: self.bands.frame(at),
        }
    }

    /// Aggregate snapshot followed by the fine snapshot, both in the existing
    /// numeric motion format. No PCM or alternate message channel is needed.
    pub fn write_transport(&self, output: &mut [f64]) {
        assert_eq!(output.len(), Self::TRANSPORT_LEN);
        let (bands, slices) = output.split_at_mut(Self::BAND_TRANSPORT_LEN);
        self.bands.write_transport(bands);
        self.slices.write_transport(slices);
    }

    pub fn from_transport(input: &[f64]) -> Option<Self> {
        if input.len() != Self::TRANSPORT_LEN {
            return None;
        }
        let (bands, slices) = input.split_at(Self::BAND_TRANSPORT_LEN);
        if bands[..2] != slices[..2] {
            return None;
        }
        Some(Self {
            bands: DisplaySnapshot::from_transport(bands)?,
            slices: DisplaySnapshot::from_transport(slices)?,
        })
    }
}

/// Interpolated integer-Hz display labels within each existing one-Bark
/// interval. Intermediate values are not exact filter boundaries.
pub fn slice_frequency_edges() -> [u32; BROWSER_SLICES + 1] {
    core::array::from_fn(|i| {
        if i == BROWSER_SLICES {
            return BARK_EDGES[DISPLAY_BANDS] as u32;
        }
        let group = i / SLICES_PER_GROUP;
        let start = BARK_EDGES[group] as u32;
        let end = BARK_EDGES[group + 1] as u32;
        start + (end - start) * (i % SLICES_PER_GROUP) as u32 / SLICES_PER_GROUP as u32
    })
}

/// Repeat each of the 24 fixed HSLuv colors ten times. Sound never changes color.
pub fn slice_colors(saturation: f32, luminance: f32) -> [LinSrgb<f32>; BROWSER_SLICES] {
    let colors = Gradient::<DISPLAY_BANDS>::new_rainbow(saturation, luminance).colors;
    core::array::from_fn(|i| colors[i / SLICES_PER_GROUP])
}

#[cfg(test)]
mod tests;
