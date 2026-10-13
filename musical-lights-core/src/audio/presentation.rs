//! Shared presentation of canonical ISO specific loudness, independent of hardware.
//! Shared-coefficient 1 Euro smoothing follows Casiez et al. (2012).
//! Onsets use causal log-loudness changes inspired by Bello et al. (2005).
//! Detector thresholds and white flashes are engineering choices, not ISO equations.
use super::{
    loudness::{FRAME_SAMPLES, LoudnessFrame, SAMPLE_RATE},
    settings::AudioSettings,
    visual::{BASS_BANDS, BandLevel, DISPLAY_BANDS, DisplayFrame},
};
use num::Float;
const DT: f64 = FRAME_SAMPLES as f64 / SAMPLE_RATE as f64;
const HISTORY: usize = 50;
const COMPARE_HISTORY: usize = 11;
pub const ATTACK_FLASH_SECONDS: f64 = 0.180;
fn alpha(cutoff: f64) -> f64 {
    1.0 / (1.0 + 1.0 / (2.0 * core::f64::consts::PI * cutoff * DT))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoudnessSnapshot {
    at: f64,
    reduced: bool,
    pub targets: [f32; DISPLAY_BANDS],
    pub filtered: [f32; DISPLAY_BANDS],
    pub attacks: [Option<f64>; DISPLAY_BANDS],
    pub total_sones: f64,
    pub gain: f64,
    pub flash_seconds: f64,
    pub sones: [f32; DISPLAY_BANDS],
}
impl LoudnessSnapshot {
    pub const VERSION: f64 = 5.0;
    pub const TRANSPORT_LEN: usize = 6 + DISPLAY_BANDS * 4;
    pub fn new(at: f64) -> Self {
        Self {
            at,
            reduced: false,
            targets: [0.0; DISPLAY_BANDS],
            filtered: [0.0; DISPLAY_BANDS],
            attacks: [None; DISPLAY_BANDS],
            total_sones: 0.0,
            gain: 1.0,
            flash_seconds: 0.180,
            sones: [0.0; DISPLAY_BANDS],
        }
    }
    pub fn timestamp(&self) -> f64 {
        self.at
    }
    pub fn frame(&self, at: f64) -> DisplayFrame<DISPLAY_BANDS> {
        DisplayFrame {
            levels: self.filtered,
            edges: self.attacks.map(|attack| {
                attack.map_or(0.0, |start| {
                    let age = (at - start).max(0.0);
                    if age >= self.flash_seconds {
                        0.0
                    } else {
                        ((1.0 - age / self.flash_seconds) * if self.reduced { 0.5 } else { 1.0 })
                            as f32
                    }
                })
            }),
        }
    }
    pub fn panel_frame(&self, at: f64) -> DisplayFrame<{ super::visual::PANEL_ROWS }> {
        let frame = self.frame(at);
        let levels = core::array::from_fn(|row| {
            if row == 0 {
                frame.levels[..BASS_BANDS].iter().sum::<f32>()
            } else {
                frame.levels[row + BASS_BANDS - 1]
            }
        });
        let maximum = levels.iter().copied().fold(1.0_f32, f32::max);
        DisplayFrame {
            levels: levels.map(|v| v / maximum),
            edges: core::array::from_fn(|row| {
                if row == 0 {
                    frame.edges[..BASS_BANDS]
                        .iter()
                        .copied()
                        .fold(0.0_f32, f32::max)
                } else {
                    frame.edges[row + BASS_BANDS - 1]
                }
            }),
        }
    }
    pub fn write_transport(&self, out: &mut [f64]) {
        assert_eq!(out.len(), Self::TRANSPORT_LEN);
        out[..3].copy_from_slice(&[self.at, f64::from(self.reduced), Self::VERSION]);
        out[99..102].copy_from_slice(&[self.total_sones, self.gain, self.flash_seconds]);
        for i in 0..DISPLAY_BANDS {
            out[3 + i * 4..7 + i * 4].copy_from_slice(&[
                self.targets[i] as f64,
                self.filtered[i] as f64,
                self.attacks[i].unwrap_or(-1.0),
                self.sones[i] as f64,
            ]);
        }
    }
    pub fn from_transport(input: &[f64]) -> Option<Self> {
        if input.len() != Self::TRANSPORT_LEN
            || input[2] != Self::VERSION
            || !input.iter().all(|x| x.is_finite())
            || input[0] < 0.0
            || ![0.0, 1.0].contains(&input[1])
        {
            return None;
        }
        if input[99] < 0.0 || input[100] <= 0.0 || !(0.02..=1.0).contains(&input[101]) {
            return None;
        }
        let mut state = Self::new(input[0]);
        state.total_sones = input[99];
        state.gain = input[100];
        state.flash_seconds = input[101];
        state.reduced = input[1] == 1.0;
        for i in 0..DISPLAY_BANDS {
            let row = &input[3 + i * 4..7 + i * 4];
            if !(0.0..=1.0).contains(&row[0])
                || !(0.0..=1.0).contains(&row[1])
                || !(row[2] == -1.0 || (0.0..=state.at).contains(&row[2]))
                || !(0.0..=f32::MAX as f64).contains(&row[3])
            {
                return None;
            }
            state.targets[i] = row[0] as f32;
            state.filtered[i] = row[1] as f32;
            state.attacks[i] = (row[2] >= 0.0).then_some(row[2]);
            state.sones[i] = row[3] as f32;
        }
        Some(state)
    }
}

pub struct LoudnessPresentation {
    pub snapshot: LoudnessSnapshot,
    derivative: [f64; DISPLAY_BANDS],
    filtered: [f64; DISPLAY_BANDS],
    pub acoustic: AcousticAttacks,
    visual_armed: [bool; DISPLAY_BANDS],
    pub suppressed: [u32; DISPLAY_BANDS],
    settings: AudioSettings,
}
pub struct AcousticAttacks {
    history: [[f32; DISPLAY_BANDS]; HISTORY],
    sones_history: [[f32; DISPLAY_BANDS]; COMPARE_HISTORY],
    frames: usize,
    started_at: f64,
    armed: [bool; DISPLAY_BANDS],
    quiet: [usize; DISPLAY_BANDS],
    candidate: [Option<(f64, f64, f64)>; DISPLAY_BANDS],
    previous_sones: [f64; DISPLAY_BANDS],
    pub events: [Option<f64>; DISPLAY_BANDS],
    pub novelty: [f64; DISPLAY_BANDS],
    pub candidate_started: bool,
    pub magnitude: [f64; DISPLAY_BANDS],
}
fn frames(seconds: f64) -> usize {
    Float::round(seconds / DT).max(1.0) as usize
}
impl AcousticAttacks {
    pub fn new(at: f64) -> Self {
        Self {
            history: [[0.0; DISPLAY_BANDS]; HISTORY],
            sones_history: [[0.0; DISPLAY_BANDS]; COMPARE_HISTORY],
            frames: 0,
            started_at: at,
            armed: [true; DISPLAY_BANDS],
            quiet: [0; DISPLAY_BANDS],
            candidate: [None; DISPLAY_BANDS],
            previous_sones: [0.0; DISPLAY_BANDS],
            events: [None; DISPLAY_BANDS],
            novelty: [0.0; DISPLAY_BANDS],
            candidate_started: false,
            magnitude: [0.0; DISPLAY_BANDS],
        }
    }
    fn push(&mut self, frame: &LoudnessFrame, settings: AudioSettings) -> [bool; DISPLAY_BANDS] {
        let at = frame.sample_index as f64 / SAMPLE_RATE as f64;
        let bands = frame.bands();
        let strongest = bands.iter().copied().fold(0.0_f32, f32::max) as f64;
        let age = frames(settings.compare_seconds);
        let old = (self.frames + COMPARE_HISTORY - age) % COMPARE_HISTORY;
        let history = frames(settings.baseline_seconds);
        let mut events = [false; DISPLAY_BANDS];
        self.candidate_started = false;
        for (i, value) in bands.into_iter().enumerate() {
            let sones = value as f64;
            let before = self.sones_history[old][i] as f64;
            self.magnitude[i] = Float::log10(1.0 + sones);
            let flux = (self.magnitude[i] - Float::log10(1.0 + before)).max(0.0);
            self.novelty[i] = flux;
            let mean = (1..=history)
                .map(|age| self.history[(self.frames + HISTORY - age) % HISTORY][i] as f64)
                .sum::<f64>()
                / history as f64;
            let peak = (1..=frames(settings.peak_seconds))
                .map(|age| self.history[(self.frames + HISTORY - age) % HISTORY][i] as f64)
                .fold(0.0_f64, f64::max);
            if flux <= mean + settings.novelty_threshold * 0.5 {
                self.quiet[i] += 1;
            } else {
                self.quiet[i] = 0;
            }
            if self.quiet[i] >= frames(settings.acoustic_quiet) {
                self.armed[i] = true;
            }
            if self.candidate[i].is_some_and(|(deadline, _, _)| at > deadline) {
                self.candidate[i] = None;
            }
            if at - self.started_at >= settings.startup_seconds
                && self.armed[i]
                && flux >= peak
                && flux > mean + settings.novelty_threshold
                && flux >= settings.relative_rise * self.magnitude[i]
                && self.candidate[i].is_none()
            {
                self.candidate[i] = Some((at + 0.060, self.previous_sones[i], frame.sones));
                self.candidate_started = true;
            }
            if self.candidate[i]
                .is_some_and(|(_, baseline, total)| sones > baseline && frame.sones >= total)
                && self.armed[i]
                && sones >= settings.minimum_sones
                && sones >= settings.prominence * strongest
                && before >= 0.95 * sones
            {
                self.events[i] = Some(at);
                events[i] = true;
                self.armed[i] = false;
                self.candidate[i] = None;
            }
            self.sones_history[self.frames % COMPARE_HISTORY][i] = value;
            self.previous_sones[i] = sones;
        }
        self.history[self.frames % HISTORY] = self.novelty.map(|v| v as f32);
        // Preserve both ring phases without an ever-growing board counter.
        self.frames = (self.frames + 1) % (HISTORY * COMPARE_HISTORY);
        events
    }
}
impl LoudnessPresentation {
    pub fn configure(&mut self, settings: AudioSettings) {
        self.settings = settings;
    }

    pub fn new(at: f64, settings: AudioSettings) -> Self {
        Self {
            snapshot: LoudnessSnapshot::new(at),
            derivative: [0.0; DISPLAY_BANDS],
            filtered: [0.0; DISPLAY_BANDS],
            acoustic: AcousticAttacks::new(at),
            visual_armed: [true; DISPLAY_BANDS],
            suppressed: [0; DISPLAY_BANDS],
            settings,
        }
    }
    pub fn push(
        &mut self,
        frame: &LoudnessFrame,
        levels: [BandLevel; DISPLAY_BANDS],
        gain: f64,
        reduced: bool,
    ) {
        self.push_policy(frame, levels, gain, reduced, true);
    }
    pub fn push_policy(
        &mut self,
        frame: &LoudnessFrame,
        levels: [BandLevel; DISPLAY_BANDS],
        gain: f64,
        reduced: bool,
        attacks_enabled: bool,
    ) {
        let at = frame.sample_index as f64 / SAMPLE_RATE as f64;
        let mut speed = 0.0_f64;
        for (i, level) in levels.iter().enumerate() {
            let derivative = (f64::from(level.activity) - self.filtered[i]) / DT;
            self.derivative[i] +=
                alpha(self.settings.smooth_derivative) * (derivative - self.derivative[i]);
            speed = speed.max(self.derivative[i].abs());
        }
        let coefficient = alpha(self.settings.smooth_min + self.settings.smooth_beta * speed);
        for (i, level) in levels.iter().enumerate() {
            self.filtered[i] += coefficient * (f64::from(level.activity) - self.filtered[i]);
            self.snapshot.targets[i] = level.activity;
            self.snapshot.filtered[i] = self.filtered[i] as f32;
            self.snapshot.sones[i] = level.sones;
        }
        self.snapshot.at = at;
        self.snapshot.reduced = reduced;
        self.snapshot.total_sones = frame.sones;
        self.snapshot.gain = gain;
        self.snapshot.flash_seconds = self.settings.flash_seconds;
        let mut events = self.acoustic.push(frame, self.settings);
        if !attacks_enabled {
            events.fill(false);
            self.acoustic.events.fill(None);
            self.acoustic.candidate.fill(None);
            self.acoustic.candidate_started = false;
        }
        for (i, event) in events.into_iter().enumerate() {
            if self.acoustic.quiet[i] >= frames(self.settings.visual_quiet) {
                self.visual_armed[i] = true;
            }
            if event {
                let interval = self.snapshot.attacks[i]
                    .is_none_or(|last| at - last >= self.settings.visual_interval - 1e-9);
                if interval && self.visual_armed[i] {
                    self.snapshot.attacks[i] = Some(at);
                    self.visual_armed[i] = false;
                } else {
                    self.suppressed[i] = self.suppressed[i].saturating_add(1);
                }
            }
        }
    }
}
#[cfg(test)]
mod tests;
