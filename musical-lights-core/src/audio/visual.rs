//! Artistic gain and motion. These values are display activity, not sones.
use super::loudness::{FRAME_SAMPLES, LoudnessFrame, SAMPLE_RATE};
use num::Float;

pub const DISPLAY_BANDS: usize = 24;
pub const BASS_BANDS: usize = 5;
pub const PANEL_ROWS: usize = DISPLAY_BANDS - BASS_BANDS + 1;
pub const BARK_EDGES: [f32; DISPLAY_BANDS + 1] = [
    0.0, 100.0, 200.0, 300.0, 400.0, 510.0, 630.0, 770.0, 920.0, 1080.0, 1270.0, 1480.0, 1720.0,
    2000.0, 2320.0, 2700.0, 3150.0, 3700.0, 4400.0, 5300.0, 6400.0, 7700.0, 9500.0, 12000.0,
    15500.0,
];

#[derive(Clone)]
pub struct VisualGain {
    log_gain: f64,
    settings: super::settings::AudioSettings,
    options: super::policy::VisualOptions,
}

impl Default for VisualGain {
    fn default() -> Self {
        Self {
            log_gain: 0.0,
            settings: Default::default(),
            options: Default::default(),
        }
    }
}

impl VisualGain {
    pub fn new(settings: super::settings::AudioSettings) -> Self {
        Self {
            log_gain: 0.0,
            settings,
            options: Default::default(),
        }
    }

    /// Current shared display gain; measured sones remain unchanged.
    pub fn factor(&self) -> f64 {
        if self.options.gain_mode == super::policy::GainMode::Off {
            return self.options.manual_gain;
        }
        Float::exp(self.log_gain)
    }

    pub fn configure(
        &mut self,
        settings: super::settings::AudioSettings,
        options: super::policy::VisualOptions,
    ) {
        self.settings = settings;
        self.options = options;
    }

    pub fn map_gated(&mut self, frame: &LoudnessFrame, closed: bool) -> [BandLevel; DISPLAY_BANDS] {
        if closed {
            frame.bands().map(|sones| BandLevel {
                activity: 0.0,
                sones,
            })
        } else {
            self.map(frame)
        }
    }

    /// One gain for the canonical 24-band spectrum, regardless of panel layout.
    pub fn map(&mut self, frame: &LoudnessFrame) -> [BandLevel; DISPLAY_BANDS] {
        self.map_bands(frame.bands(), frame.sones)
    }

    /// One shared gain for canonical Bark bands. The ISO total
    /// controls the existing 0.1-sone adaptation eligibility rule only.
    pub fn map_bands(
        &mut self,
        bands: [f32; DISPLAY_BANDS],
        total_sones: f64,
    ) -> [BandLevel; DISPLAY_BANDS] {
        let maximum = bands.iter().copied().fold(0.0_f32, f32::max) as f64;
        if self.options.gain_mode != super::policy::GainMode::Off
            && total_sones >= 0.1
            && maximum > 0.0
        {
            let target = Float::ln((self.settings.gain_target / maximum).clamp(1.0 / 64.0, 64.0));
            let tau = if target < self.log_gain {
                self.settings.gain_down
            } else {
                self.settings.gain_up
            };
            let scale = match self.options.gain_mode {
                super::policy::GainMode::Vivid => 0.25,
                super::policy::GainMode::Lazy => 2.0,
                _ => 1.0,
            };
            let alpha =
                -Float::exp_m1(-(FRAME_SAMPLES as f64 / SAMPLE_RATE as f64) / (tau * scale));
            self.log_gain += alpha * (target - self.log_gain);
        }
        let gain = self.factor() as f32;
        proportional(bands, gain)
    }
}

/// One common headroom limit preserves every source-band ratio.
fn proportional<const N: usize>(values: [f32; N], gain: f32) -> [BandLevel; N] {
    let maximum = values.iter().copied().fold(0.0_f32, f32::max);
    let scale = gain.min(1.0 / maximum);
    values.map(|sones| BandLevel {
        activity: sones * scale,
        sones,
    })
}

/// Keep the acoustic input with its artistic mapping. Motion follows activity;
/// only a rise in the input sones can restart an attack's hold and white edge.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BandLevel {
    pub activity: f32,
    pub sones: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayFrame<const N: usize> {
    pub levels: [f32; N],
    pub edges: [f32; N],
}
impl<const N: usize> Default for DisplayFrame<N> {
    fn default() -> Self {
        Self {
            levels: [0.0; N],
            edges: [0.0; N],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn common_gain_and_headroom_preserve_all_band_ratios() {
        let values = core::array::from_fn(|i| (i + 1) as f32 * 0.02);
        let mut gain = VisualGain::default();
        for _ in 0..50_000 {
            let mapped = gain.map_bands(values, 5.0);
            for i in 0..DISPLAY_BANDS {
                assert!(
                    (mapped[i].activity / mapped[23].activity - values[i] / values[23]).abs()
                        < 2e-7
                );
                assert_eq!(mapped[i].sones, values[i]);
            }
        }
        assert!((gain.map_bands(values, 5.0)[23].activity - 0.8).abs() < 0.01);
    }
    #[test]
    fn silence_freezes_gain() {
        let mut gain = VisualGain::default();
        let values = [0.2; DISPLAY_BANDS];
        gain.map_bands(values, 2.0);
        let before = gain.factor();
        let silent = gain.map_bands([0.0; DISPLAY_BANDS], 0.0);
        assert_eq!(gain.factor(), before);
        assert!(silent.iter().all(|b| b.activity == 0.0));
    }
}
