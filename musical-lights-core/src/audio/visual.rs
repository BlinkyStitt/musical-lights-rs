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
}

impl Default for VisualGain {
    fn default() -> Self {
        Self { log_gain: 0.0 }
    }
}

impl VisualGain {
    /// One gain for the canonical 24-band spectrum, regardless of panel layout.
    pub fn map(&mut self, frame: &LoudnessFrame) -> VisualLevels {
        let bands = frame.bands();
        let maximum = bands.iter().copied().fold(0.0_f32, f32::max) as f64;
        if frame.sones >= 0.1 && maximum > 0.0 {
            let target = Float::ln((4.0 / maximum).clamp(1.0 / 64.0, 64.0));
            let tau = if target < self.log_gain { 2.0 } else { 20.0 };
            let alpha = -Float::exp_m1(-(FRAME_SAMPLES as f64 / SAMPLE_RATE as f64) / tau);
            self.log_gain += alpha * (target - self.log_gain);
        }
        let gain = Float::exp(self.log_gain) as f32;
        let compress = |value: f32| {
            let x = gain * value;
            BandLevel {
                activity: x / (1.0 + x),
                sones: value,
            }
        };
        VisualLevels {
            bands: bands.map(compress),
            panel_rows: core::array::from_fn(|row| {
                compress(if row == 0 {
                    bands[..BASS_BANDS].iter().sum()
                } else {
                    bands[row + BASS_BANDS - 1]
                })
            }),
        }
    }
}

pub struct VisualLevels {
    pub bands: [BandLevel; DISPLAY_BANDS],
    pub panel_rows: [BandLevel; PANEL_ROWS],
}

/// Keep the acoustic input with its artistic mapping. Motion follows activity;
/// only a rise in the input sones can restart an attack's hold and white edge.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BandLevel {
    pub activity: f32,
    pub sones: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct FallingBand {
    height: f32,
    velocity: f32,
    hold_until: f64,
    edge: f32,
    target: BandLevel,
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

/// A complete, copyable motion state. Producers consume every audio frame;
/// renderers may discard superseded snapshots without discarding an attack.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplaySnapshot<const N: usize> {
    at: f64,
    reduced_motion: bool,
    bands: [FallingBand; N],
}

impl<const N: usize> DisplaySnapshot<N> {
    pub const TRANSPORT_LEN: usize = 2 + N * 6;

    pub fn new(at: f64) -> Self {
        Self {
            at,
            reduced_motion: false,
            bands: [FallingBand::default(); N],
        }
    }
    pub fn timestamp(&self) -> f64 {
        self.at
    }

    pub fn push(&mut self, at: f64, values: [BandLevel; N], reduced_motion: bool) {
        self.advance(at);
        self.reduced_motion = reduced_motion;
        for (band, value) in self.bands.iter_mut().zip(values) {
            if value.activity > band.height {
                band.height = value.activity;
                band.velocity = 0.0;
                if value.sones > band.target.sones {
                    band.hold_until = at + 0.350;
                    band.edge = 1.0;
                }
            }
            band.target = value;
        }
    }

    fn advance(&mut self, at: f64) {
        let at = at.max(self.at);
        let rate = if self.reduced_motion { 3.0 } else { 6.0 };
        let edge_rate = if self.reduced_motion { 5.0 } else { 10.0 };
        for band in &mut self.bands {
            if at > band.hold_until {
                let elapsed = (at - self.at.max(band.hold_until)) as f32;
                let distance = (band.height - band.target.activity).max(0.0);
                let velocity = band.velocity.min(rate * distance);
                let coefficient = rate * distance - velocity;
                let decay = Float::exp(-rate * elapsed);
                let remaining = (distance + coefficient * elapsed) * decay;
                band.height = band.target.activity + remaining;
                band.velocity = (velocity + rate * coefficient * elapsed) * decay;
                if remaining <= 0.0001 {
                    band.height = band.target.activity;
                    band.velocity = 0.0;
                }
                band.edge *= Float::exp(-edge_rate * elapsed);
                if band.edge <= 0.0001 || band.height == 0.0 {
                    band.edge = 0.0;
                }
            }
        }
        self.at = at;
    }

    /// Sampling does not change the producer's state or its audio clock.
    pub fn frame(&self, at: f64) -> DisplayFrame<N> {
        let mut state = *self;
        state.advance(at);
        DisplayFrame {
            levels: state.bands.map(|b| b.height),
            edges: state.bands.map(|b| b.edge),
        }
    }

    /// Fixed numeric transport for the separate browser WASM instances.
    /// Header: audio seconds, reduced motion. Each band: height, velocity,
    /// hold deadline, edge opacity, target activity, input sones.
    /// No PCM crosses this boundary.
    pub fn write_transport(&self, output: &mut [f64]) {
        assert_eq!(output.len(), Self::TRANSPORT_LEN);
        output[0] = self.at;
        output[1] = f64::from(self.reduced_motion);
        for (out, band) in output[2..]
            .as_chunks_mut::<6>()
            .0
            .iter_mut()
            .zip(self.bands)
        {
            out.copy_from_slice(&[
                band.height as f64,
                band.velocity as f64,
                band.hold_until,
                band.edge as f64,
                band.target.activity as f64,
                band.target.sones as f64,
            ]);
        }
    }

    pub fn from_transport(input: &[f64]) -> Option<Self> {
        if input.len() != Self::TRANSPORT_LEN
            || !input.iter().all(|x| x.is_finite())
            || input[0] < 0.0
            || ![0.0, 1.0].contains(&input[1])
        {
            return None;
        }
        let mut state = Self::new(input[0]);
        state.reduced_motion = input[1] == 1.0;
        for (band, row) in state
            .bands
            .iter_mut()
            .zip(input[2..].as_chunks::<6>().0.iter())
        {
            if ![row[0], row[3], row[4]]
                .iter()
                .all(|v| (0.0..=1.0).contains(v))
                || row[1] < 0.0
                || row[1] > f32::MAX as f64
                || row[2] < 0.0
                || !(0.0..=f32::MAX as f64).contains(&row[5])
            {
                return None;
            }
            *band = FallingBand {
                height: row[0] as f32,
                velocity: row[1] as f32,
                hold_until: row[2],
                edge: row[3] as f32,
                target: BandLevel {
                    activity: row[4] as f32,
                    sones: row[5] as f32,
                },
            };
        }
        Some(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;
    use std::vec::Vec;

    // These motion tests use a fixed proportional mapping. Tests with
    // VisualGain below cover the actual adaptive and compressed mapping.
    fn level(activity: f32) -> BandLevel {
        BandLevel {
            activity,
            sones: activity,
        }
    }

    #[test]
    fn short_tap_survives_a_large_audio_block_and_render_stalls_do_not_replay_it() {
        let mut state = DisplaySnapshot::<24>::new(0.0);
        state.push(0.100, [level(0.8); 24], false);
        state.push(0.110, [level(0.0); 24], false);
        assert_eq!(state.frame(0.120).levels, [0.8; 24]);
        assert_eq!(state.frame(0.450).edges, [1.0; 24]);
        assert_eq!(state.frame(3.0).levels, [0.0; 24]);
        assert_eq!(state.frame(3.0).edges, [0.0; 24]);
        assert_eq!(state.timestamp(), 0.110);
    }

    #[test]
    fn render_sampling_cannot_change_the_motion_or_hold_deadline() {
        for reduced in [false, true] {
            let mut state = DisplaySnapshot::<1>::new(0.0);
            state.push(0.0, [level(1.0)], reduced);
            state.push(0.010, [level(0.0)], reduced);
            let rate = if reduced { 3.0 } else { 6.0 };
            let expected = (1.0 + rate) * Float::exp(-rate);
            for hz in [30, 60, 120, 144, 240] {
                let mut previous = 1.0;
                for tick in 0..=hz {
                    let frame = state.frame(0.350 + tick as f64 / hz as f64);
                    assert!((0.0..=previous).contains(&frame.levels[0]));
                    assert!(frame.edges[0] <= frame.levels[0]);
                    previous = frame.levels[0];
                }
                assert!((previous - expected).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn transport_preserves_motion_and_rejects_corrupt_state() {
        let mut state = DisplaySnapshot::<24>::new(0.0);
        state.push(1.0, [level(0.7); 24], true);
        state.push(1.5, [level(0.1); 24], true);
        let mut wire = [0.0; DisplaySnapshot::<24>::TRANSPORT_LEN];
        state.write_transport(&mut wire);
        let mut decoded = DisplaySnapshot::<24>::from_transport(&wire).unwrap();
        assert_eq!(state, decoded);
        assert_eq!(state.frame(2.0), decoded.frame(2.0));
        // A received snapshot must retain the acoustic target, including when
        // gain raises activity while the sound is constant or falling.
        for (at, activity, sones) in [(5.0, 0.5, 0.1), (5.1, 0.6, 0.09)] {
            decoded.push(at, [BandLevel { activity, sones }; 24], true);
            assert_eq!(decoded.frame(at).levels, [activity; 24]);
            assert_eq!(decoded.frame(at).edges, [0.0; 24]);
            assert!(decoded.bands[0].hold_until < at);
        }
        for invalid in [-1.0, f32::MAX as f64 * 2.0, f64::INFINITY, f64::NAN] {
            wire[7] = invalid;
            assert!(DisplaySnapshot::<24>::from_transport(&wire).is_none());
        }
        state.write_transport(&mut wire);
        wire[5] = f64::NAN;
        assert!(DisplaySnapshot::<24>::from_transport(&wire).is_none());
    }

    #[test]
    fn shared_gain_preserves_sustained_activity_and_does_not_modify_loudness() {
        let mut gain = VisualGain::default();
        let frame = LoudnessFrame {
            sample_index: 0,
            sones: 6.0,
            specific_sones_per_bark: core::array::from_fn(|i| {
                if i < 10 {
                    4.0
                } else if i < 20 {
                    2.0
                } else {
                    0.0
                }
            }),
        };
        let mut values = gain.map(&frame);
        for _ in 0..30_000 {
            values = gain.map(&frame);
        }
        assert!((values.bands[0].activity - 0.8).abs() < 1e-6);
        assert!((values.bands[1].activity - 2.0 / 3.0).abs() < 1e-6);
        assert!((values.panel_rows[0].activity - 6.0 / 7.0).abs() < 1e-6);
        assert_eq!(values.bands[0].sones, 4.0);
        assert_eq!(values.bands[1].sones, 2.0);
        assert_eq!(values.panel_rows[0].sones, 6.0);
        assert_eq!(frame.sones, 6.0);
        let previous_gain = gain.log_gain;
        let silence = LoudnessFrame {
            sample_index: 0,
            sones: 0.0,
            specific_sones_per_bark: [0.0; 240],
        };
        assert_eq!(gain.map(&silence).bands, [BandLevel::default(); 24]);
        assert_eq!(gain.log_gain, previous_gain);
    }
    #[test]
    fn combined_bar_and_white_edge_limit_flashes_under_rapid_changes() {
        // Sample the fixed side edge and the moving top edge at each height.
        // Count luminance reversals >= 0.1, including a white border crossing a
        // pixel that was already colored. Height-only checks miss that case.
        for reduced_motion in [false, true] {
            for period_ms in [20, 80, 150, 250, 350, 500, 800] {
                for plot_luminance in [0.01_f32, 0.92] {
                    let mut display = DisplaySnapshot::<24>::new(0.0);
                    let mut previous = [plot_luminance; 200];
                    let mut direction = [0_i8; 200];
                    let mut reversals: [Vec<usize>; 200] = core::array::from_fn(|_| Vec::new());
                    for ms in (0..6000).step_by(2) {
                        let input = if ms % period_ms < 10 { 1.0 } else { 0.0 };
                        display.push(
                            ms as f64 / 1000.0,
                            [level(input); DISPLAY_BANDS],
                            reduced_motion,
                        );
                        let frame = display.frame(ms as f64 / 1000.0);
                        for pixel in 0..200 {
                            let y = ((pixel % 100) as f32 + 0.5) / 100.0;
                            let height = frame.levels[0];
                            let lit = y <= height;
                            let border = pixel < 100 || height - y <= 1.0 / 320.0;
                            let luminance = if lit {
                                let color = 0.26;
                                if border {
                                    color + (1.0 - color) * frame.edges[0]
                                } else {
                                    color
                                }
                            } else {
                                plot_luminance
                            };
                            let delta = luminance - previous[pixel];
                            let next = if delta >= 0.1 {
                                1
                            } else if delta <= -0.1 {
                                -1
                            } else {
                                0
                            };
                            if next != 0 {
                                if next != direction[pixel] {
                                    reversals[pixel].push(ms);
                                    reversals[pixel].retain(|&time| ms - time < 1000);
                                    assert!(
                                        reversals[pixel].len() <= 7,
                                        "more than three flash pairs at {ms} ms, pixel {pixel}, period {period_ms}, reduced={reduced_motion}, plot={plot_luminance}"
                                    );
                                }
                                direction[pixel] = next;
                                previous[pixel] = luminance;
                            } else if direction[pixel] == 1 {
                                previous[pixel] = previous[pixel].max(luminance);
                            } else if direction[pixel] == -1 {
                                previous[pixel] = previous[pixel].min(luminance);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn new_peak_cancels_velocity_and_rising_floor_brakes_before_contact() {
        for reduced in [false, true] {
            let mut state = DisplaySnapshot::<1>::new(0.0);
            state.push(0.0, [level(1.0)], reduced);
            state.push(0.002, [level(0.0)], reduced);
            let height = state.frame(0.8).levels[0];
            let floor = height - 0.001;
            state.push(0.8, [level(floor)], reduced);
            let next = state.frame(0.808).levels[0];
            assert!(next > floor + 0.0008 && next < height);
            assert_eq!(state.frame(5.0).levels, [floor]);
            state.push(0.816, [level(0.9)], reduced);
            assert_eq!(state.frame(0.820).levels, [0.9]);
            assert_eq!(state.bands[0].velocity, 0.0);
        }
    }
    #[test]
    fn steady_sound_fades_its_edge_without_retriggering() {
        let mut state = DisplaySnapshot::<24>::new(0.0);
        for step in 0..2500 {
            state.push(step as f64 * 0.002, [level(0.5); 24], false);
        }
        assert_eq!(state.frame(5.0).levels, [0.5; 24]);
        assert_eq!(state.frame(5.0).edges, [0.0; 24]);
    }

    #[test]
    fn adapting_gain_does_not_restart_a_steady_sounds_edge() {
        for reduced in [false, true] {
            let mut gain = VisualGain::default();
            let mut state = DisplaySnapshot::new(0.0);
            let mut sound = LoudnessFrame {
                sample_index: 0,
                sones: 0.2,
                specific_sones_per_bark: [0.0; 240],
            };
            sound.specific_sones_per_bark[..10].fill(0.2);
            let mut early = 0.0;
            for step in 0..50_000 {
                let at = step as f64 * 0.002;
                state.push(at, gain.map(&sound).bands, reduced);
                if step == 5000 {
                    early = state.frame(at).levels[0];
                }
                if step >= 5000 {
                    assert_eq!(
                        state.frame(at).edges,
                        [0.0; 24],
                        "steady sound at {at}, reduced={reduced}"
                    );
                }
            }
            assert!(state.frame(100.0).levels[0] > early + 0.1);
            sound.specific_sones_per_bark[..10].fill(0.4);
            sound.sones = 0.4;
            state.push(100.0, gain.map(&sound).bands, reduced);
            assert_eq!(state.frame(100.0).edges[0], 1.0);
        }
    }
}
