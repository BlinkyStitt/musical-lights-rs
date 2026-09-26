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
    /// Browser presentation shelf: unity through 2 kHz, rising by one unit
    /// over two octaves to 2x at 8 kHz. This is artistic emphasis, not sones.
    pub fn browser_treble_weight(band: usize) -> f32 {
        let center = (BARK_EDGES[band] + BARK_EDGES[band + 1]) * 0.5;
        1.0 + (Float::log2(center / 2000.0) * 0.5).clamp(0.0, 1.0)
    }

    /// Keep the measured partial loudness for acoustic edges and diagnostics;
    /// only browser heights receive the frequency shelf before shared gain.
    pub fn map_browser_partial(
        &mut self,
        bands: [f32; DISPLAY_BANDS],
        total_sones: f64,
    ) -> [BandLevel; DISPLAY_BANDS] {
        let emphasized = core::array::from_fn(|i| bands[i] * Self::browser_treble_weight(i));
        let mut mapped = self.map_bands(emphasized, total_sones).bands;
        for (level, sones) in mapped.iter_mut().zip(bands) {
            level.sones = sones;
        }
        mapped
    }

    /// Current shared display gain; measured sones remain unchanged.
    pub fn factor(&self) -> f64 {
        Float::exp(self.log_gain)
    }

    /// One gain for the canonical 24-band spectrum, regardless of panel layout.
    pub fn map(&mut self, frame: &LoudnessFrame) -> VisualLevels {
        self.map_bands(frame.bands(), frame.sones)
    }

    /// One shared gain for partial source bands. The unchanged ISO total
    /// controls the existing 0.1-sone adaptation eligibility rule only.
    pub fn map_bands(&mut self, bands: [f32; DISPLAY_BANDS], total_sones: f64) -> VisualLevels {
        let maximum = bands.iter().copied().fold(0.0_f32, f32::max) as f64;
        if total_sones >= 0.1 && maximum > 0.0 {
            let target = Float::ln((0.8 / maximum).clamp(1.0 / 64.0, 64.0));
            let tau = if target < self.log_gain { 2.0 } else { 20.0 };
            let alpha = -Float::exp_m1(-(FRAME_SAMPLES as f64 / SAMPLE_RATE as f64) / tau);
            self.log_gain += alpha * (target - self.log_gain);
        }
        let gain = self.factor() as f32;
        let panel = core::array::from_fn(|row| {
            if row == 0 {
                bands[..BASS_BANDS].iter().sum()
            } else {
                bands[row + BASS_BANDS - 1]
            }
        });
        VisualLevels {
            bands: proportional(bands, gain),
            panel_rows: proportional(panel, gain),
        }
    }
}

/// A common headroom limit preserves every ratio within each physical layout.
/// The panel sums its five bass bands before choosing its common scale.
fn proportional<const N: usize>(values: [f32; N], gain: f32) -> [BandLevel; N] {
    let maximum = values.iter().copied().fold(0.0_f32, f32::max);
    let scale = gain.min(1.0 / maximum);
    values.map(|sones| BandLevel {
        activity: sones * scale,
        sones,
    })
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
struct AcousticEdge {
    peak_sones: f32,
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

/// Current mapped targets and an independent acoustic edge envelope.
/// Producers consume every model frame; sampling never retains old heights.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplaySnapshot<const N: usize> {
    at: f64,
    reduced_motion: bool,
    bands: [AcousticEdge; N],
}
impl<const N: usize> DisplaySnapshot<N> {
    pub const TRANSPORT_LEN: usize = 2 + N * 5;
    pub fn new(at: f64) -> Self {
        Self {
            at,
            reduced_motion: false,
            bands: [AcousticEdge::default(); N],
        }
    }
    pub fn timestamp(&self) -> f64 {
        self.at
    }
    pub fn push(&mut self, at: f64, values: [BandLevel; N], reduced_motion: bool) {
        self.advance(at);
        self.reduced_motion = reduced_motion;
        for (band, value) in self.bands.iter_mut().zip(values) {
            // Only acoustic rises above the retained acoustic peak restart white.
            // Gain changes have no path into this decision.
            if value.sones > band.peak_sones && value.sones > band.target.sones {
                band.peak_sones = value.sones;
                band.hold_until = at + 0.350;
                band.edge = 1.0;
            }
            band.target = value;
        }
    }
    fn advance(&mut self, at: f64) {
        let at = at.max(self.at);
        let edge_rate = if self.reduced_motion { 20.0 } else { 30.0 };
        for band in &mut self.bands {
            if at > band.hold_until {
                let elapsed = (at - self.at.max(band.hold_until)) as f32;
                band.peak_sones =
                    (band.peak_sones * Float::exp(-7.5 * elapsed)).max(band.target.sones);
                let age = (self.at - band.hold_until).max(0.0) as f32;
                band.edge *= (1.0 + edge_rate * elapsed / (1.0 + edge_rate * age))
                    * Float::exp(-edge_rate * elapsed);
                if band.edge <= 0.0001 {
                    band.edge = 0.0;
                }
            }
        }
        self.at = at;
    }
    pub fn frame(&self, at: f64) -> DisplayFrame<N> {
        let mut state = *self;
        state.advance(at);
        DisplayFrame {
            levels: state.bands.map(|b| b.target.activity),
            edges: state.bands.map(|b| b.edge),
        }
    }
    /// Audio seconds, reduced motion, then per band: current target, acoustic
    /// peak sones, edge hold deadline, edge opacity, current input sones. No PCM.
    pub fn write_transport(&self, output: &mut [f64]) {
        assert_eq!(output.len(), Self::TRANSPORT_LEN);
        output[0] = self.at;
        output[1] = f64::from(self.reduced_motion);
        for (out, band) in output[2..]
            .as_chunks_mut::<5>()
            .0
            .iter_mut()
            .zip(self.bands)
        {
            out.copy_from_slice(&[
                band.target.activity as f64,
                band.peak_sones as f64,
                band.hold_until,
                band.edge as f64,
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
            .zip(input[2..].as_chunks::<5>().0.iter())
        {
            if ![row[0], row[3]].iter().all(|v| (0.0..=1.0).contains(v))
                || row[2] < 0.0
                || ![row[1], row[4]]
                    .iter()
                    .all(|v| (0.0..=f32::MAX as f64).contains(v))
            {
                return None;
            }
            *band = AcousticEdge {
                peak_sones: row[1] as f32,
                hold_until: row[2],
                edge: row[3] as f32,
                target: BandLevel {
                    activity: row[0] as f32,
                    sones: row[4] as f32,
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

    // These motion tests use a fixed proportional mapping. Tests with
    // VisualGain below cover the actual adaptive proportional mapping.
    fn level(activity: f32) -> BandLevel {
        BandLevel {
            activity,
            sones: activity,
        }
    }

    #[test]
    fn browser_emphasis_preserves_measurements_and_uses_one_common_gain() {
        let mut gain = VisualGain::default();
        let mut bands = [0.0; DISPLAY_BANDS];
        bands[8] = 1.0;
        bands[21] = 0.2;
        for _ in 0..1000 {
            let mapped = gain.map_browser_partial(bands, 2.0);
            assert_eq!(mapped[8].sones, 1.0);
            assert_eq!(mapped[21].sones, 0.2);
            assert!((mapped[21].activity / mapped[8].activity - 0.4).abs() < 1e-6);
            assert_eq!(mapped[23], BandLevel::default());
        }
        assert_eq!(
            gain.map_browser_partial([0.0; DISPLAY_BANDS], 0.0),
            [BandLevel::default(); DISPLAY_BANDS]
        );
        // The terminal and hardware retain the unweighted proportional mapping.
        let mapped = gain.map_bands(bands, 2.0);
        assert!((mapped.bands[21].activity / mapped.bands[8].activity - 0.2).abs() < 1e-6);
    }

    #[test]
    fn current_targets_preserve_loudness_ratios_during_gain_adaptation() {
        let mut gain = VisualGain::default();
        let mut state = DisplaySnapshot::new(0.0);
        for step in 0..50_000 {
            let amplitude = if step < 10_000 { 4.0 } else { 0.04 };
            let frame = LoudnessFrame {
                sample_index: step * 96,
                sones: amplitude * 1.1,
                specific_sones_per_bark: core::array::from_fn(|i| {
                    if i < 10 {
                        amplitude
                    } else if i < 20 {
                        amplitude * 0.1
                    } else {
                        0.0
                    }
                }),
            };
            let mapped = gain.map(&frame);
            let peak = mapped.bands[0].activity;
            assert!((mapped.bands[1].activity / peak - 0.1).abs() < 1e-6);
            let at = step as f64 * 0.002;
            state.push(at, mapped.bands, false);
            assert_eq!(
                state.frame(at).levels,
                mapped.bands.map(|band| band.activity)
            );
        }
    }

    #[test]
    fn falling_targets_do_not_retain_previous_heights() {
        let mut state = DisplaySnapshot::<1>::new(0.0);
        state.push(0.0, [level(1.0)], false);
        state.push(0.002, [level(0.1)], false);
        assert_eq!(state.frame(0.002).levels, [0.1]);
        state.push(0.004, [level(0.0)], false);
        assert_eq!(state.frame(0.004).levels, [0.0]);
    }

    #[test]
    fn short_tap_keeps_only_its_edge_and_render_stalls_do_not_replay_it() {
        let mut state = DisplaySnapshot::<24>::new(0.0);
        state.push(0.100, [level(0.8); 24], false);
        state.push(0.110, [level(0.0); 24], false);
        assert_eq!(state.frame(0.120).levels, [0.0; 24]);
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
            for hz in [30, 60, 120, 144, 240] {
                let mut previous = 1.0;
                for tick in 0..=hz {
                    let frame = state.frame(0.350 + tick as f64 / hz as f64);
                    assert_eq!(frame.levels[0], 0.0);
                    assert!(frame.edges[0] <= previous);
                    previous = frame.edges[0];
                }
                assert_eq!(previous, 0.0);
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
            wire[6] = invalid;
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
        assert!((values.bands[1].activity - 0.4).abs() < 1e-6);
        assert!((values.panel_rows[0].activity - 1.0).abs() < 1e-6);
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
    fn steady_sound_fades_its_edge_without_retriggering() {
        let mut state = DisplaySnapshot::<24>::new(0.0);
        for step in 0..2500 {
            state.push(step as f64 * 0.002, [level(0.5); 24], false);
        }
        assert_eq!(state.frame(5.0).levels, [0.5; 24]);
        assert_eq!(state.frame(5.0).edges, [0.0; 24]);
    }

    #[test]
    fn white_edge_has_a_short_damped_tail_independent_of_targets() {
        for (reduced, edge_rate) in [(false, 30.0), (true, 20.0)] {
            let mut state = DisplaySnapshot::<1>::new(0.0);
            state.push(0.0, [level(1.0)], reduced);
            state.push(0.002, [level(0.0)], reduced);
            assert_eq!(state.frame(0.350).edges, [1.0]);
            for elapsed in [0.05, 0.1, 0.2, 0.3] {
                let frame = state.frame(0.350 + elapsed);
                let expected_edge = (1.0 + edge_rate * elapsed) * Float::exp(-edge_rate * elapsed);
                assert!((frame.edges[0] as f64 - expected_edge).abs() < 1e-6);
                assert_eq!(frame.levels[0], 0.0);
            }
            assert!(state.frame(0.550).edges[0] < 0.1);
            assert_eq!(state.frame(1.0).edges, [0.0]);
            // Advancing the producer in small blocks gives the same fade as
            // sampling one snapshot after a stalled render loop.
            let reference = state.frame(0.55);
            for step in 2..=275 {
                state.push(step as f64 * 0.002, [level(0.0)], reduced);
            }
            assert!((state.frame(0.55).edges[0] - reference.edges[0]).abs() < 1e-6);
        }
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
