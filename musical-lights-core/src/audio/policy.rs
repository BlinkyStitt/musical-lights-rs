//! Visual policy only. PCM and calibrated loudness never pass through this gate.
use super::loudness::{FRAME_SAMPLES, SAMPLE_RATE};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GainMode {
    Off,
    #[default]
    Normal,
    Vivid,
    Lazy,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VisualOptions {
    pub gate_enabled: bool,
    pub gate_sones: f64,
    pub gain_mode: GainMode,
    pub manual_gain: f64,
}
impl Default for VisualOptions {
    fn default() -> Self {
        Self {
            gate_enabled: false,
            gate_sones: 0.1,
            gain_mode: GainMode::Normal,
            manual_gain: 1.0,
        }
    }
}
impl VisualOptions {
    pub fn from_values(values: &[f64]) -> Option<Self> {
        if values.len() != 4
            || !values.iter().all(|v| v.is_finite())
            || ![0.0, 1.0].contains(&values[0])
            || values[1] <= 0.0
            || !(1.0 / 64.0..=64.0).contains(&values[3])
        {
            return None;
        }
        let gain_mode = match values[2] {
            0.0 => GainMode::Off,
            1.0 => GainMode::Normal,
            2.0 => GainMode::Vivid,
            3.0 => GainMode::Lazy,
            _ => return None,
        };
        Some(Self {
            gate_enabled: values[0] == 1.0,
            gate_sones: values[1],
            gain_mode,
            manual_gain: values[3],
        })
    }
    pub fn values(self) -> [f64; 4] {
        [
            f64::from(self.gate_enabled),
            self.gate_sones,
            match self.gain_mode {
                GainMode::Off => 0.0,
                GainMode::Normal => 1.0,
                GainMode::Vivid => 2.0,
                GainMode::Lazy => 3.0,
            },
            self.manual_gain,
        ]
    }
}

/// Authoritative visual policy state, independent of rounded readouts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum GateState {
    Disabled = 0,
    Open = 1,
    Closed = 2,
    DigitalBypass = 3,
}

/// Evaluated only on emitted 2 ms loudness frames, using the pre-gain total.
#[derive(Default)]
pub struct MicrophoneGate {
    quiet_samples: u32,
    open: bool,
}
impl MicrophoneGate {
    pub fn configure(&mut self, previous: VisualOptions, next: VisualOptions) {
        if !previous.gate_enabled && next.gate_enabled {
            *self = Self::default();
        } else if previous.gate_sones != next.gate_sones {
            self.quiet_samples = 0;
        }
    }
    pub fn is_open(&self) -> bool {
        self.open
    }
    pub fn push(&mut self, sones: f64, floor: f64) {
        if self.open {
            if sones < 0.8 * floor {
                self.quiet_samples += FRAME_SAMPLES as u32;
                if self.quiet_samples >= SAMPLE_RATE / 10 {
                    self.open = false;
                    self.quiet_samples = 0;
                }
            } else {
                self.quiet_samples = 0;
            }
        } else if sones >= floor {
            self.open = true;
            self.quiet_samples = 0;
        }
    }
    pub fn state(&self, microphone: bool, enabled: bool) -> GateState {
        if !microphone {
            GateState::DigitalBypass
        } else if !enabled {
            GateState::Disabled
        } else if self.open {
            GateState::Open
        } else {
            GateState::Closed
        }
    }
}
