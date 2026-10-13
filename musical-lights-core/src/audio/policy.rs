//! Visual policy only. PCM and calibrated loudness never pass through this gate.
use num::Float;

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
    pub gate_dbfs: f64,
    pub gain_mode: GainMode,
    pub manual_gain: f64,
}
impl Default for VisualOptions {
    fn default() -> Self {
        Self {
            gate_enabled: false,
            gate_dbfs: -60.0,
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
            || !(-90.0..=-20.0).contains(&values[1])
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
            gate_dbfs: values[1],
            gain_mode,
            manual_gain: values[3],
        })
    }
    pub fn values(self) -> [f64; 4] {
        [
            f64::from(self.gate_enabled),
            self.gate_dbfs,
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

/// Non-overlapping 10 ms RMS windows at 48 kHz, independent of callback size.
pub struct MicrophoneGate {
    power: f64,
    samples: usize,
    quiet_windows: u8,
    open: bool,
    close_power: f64,
    open_power: f64,
}
impl Default for MicrophoneGate {
    fn default() -> Self {
        let mut gate = Self {
            power: 0.0,
            samples: 0,
            quiet_windows: 0,
            open: false,
            close_power: 0.0,
            open_power: 0.0,
        };
        gate.set_threshold(-60.0);
        gate
    }
}
impl MicrophoneGate {
    pub fn set_threshold(&mut self, dbfs: f64) {
        self.close_power = Float::powf(10.0, dbfs / 10.0);
        self.open_power = Float::powf(10.0, (dbfs + 3.0) / 10.0);
    }
    pub fn is_open(&self) -> bool {
        self.open
    }
    pub fn push(&mut self, pcm: &[f32]) {
        for &sample in pcm {
            self.power += f64::from(sample) * f64::from(sample);
            self.samples += 1;
            if self.samples == 480 {
                let power = self.power / 480.0;
                if self.open {
                    if power < self.close_power {
                        self.quiet_windows += 1;
                    } else {
                        self.quiet_windows = 0;
                    }
                    if self.quiet_windows == 10 {
                        self.open = false;
                        self.quiet_windows = 0;
                    }
                } else if power >= self.open_power {
                    self.open = true;
                    self.quiet_windows = 0;
                }
                self.samples = 0;
                self.power = 0.0;
            }
        }
    }
}
