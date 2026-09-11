//! Continuous ISO 532-1:2017 time-varying loudness at 48 kHz.
//!
//! Input calibration converts PCM to pascals. No visual gain, noise gate or
//! artistic envelope belongs in this module. Samples and filter states use f64
//! internally, including the low-frequency second-order sections.
mod spectrum;
mod tables;
mod temporal;
#[cfg(test)]
mod tests;

use core::array;
use num::Float;
use thiserror::Error;

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: u64 = 96;
pub const SPECIFIC_BINS: usize = 240;
const LEVEL_STEP: u64 = 24;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SoundField {
    #[default]
    Free,
    Diffuse,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Calibration {
    pascals_per_unit: f32,
    measured: bool,
}

impl Default for Calibration {
    fn default() -> Self {
        // RMS 1 PCM = 100 dB SPL is an explicit assumption, not a measurement.
        Self {
            pascals_per_unit: 2.0,
            measured: false,
        }
    }
}

impl Calibration {
    pub fn measured(pascals_per_unit: f32) -> Result<Self, LoudnessError> {
        if !pascals_per_unit.is_finite() || pascals_per_unit <= 0.0 {
            return Err(LoudnessError::InvalidCalibration);
        }
        Ok(Self {
            pascals_per_unit,
            measured: true,
        })
    }

    pub fn from_reference(rms: f64, level_db_spl: f64) -> Result<Self, LoudnessError> {
        if !rms.is_finite() || rms <= 0.0 || !level_db_spl.is_finite() {
            return Err(LoudnessError::InvalidCalibration);
        }
        Self::measured((2e-5 * Float::powf(10.0, level_db_spl / 20.0) / rms) as f32)
    }

    pub fn pascals_per_unit(self) -> f32 {
        self.pascals_per_unit
    }
    pub fn is_measured(self) -> bool {
        self.measured
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Error)]
pub enum LoudnessError {
    #[error("calibration must specify finite positive pressure per PCM unit")]
    InvalidCalibration,
    #[error("audio block is empty")]
    EmptyBlock,
    #[error("sample {index} is not finite")]
    NonFiniteSample { index: usize },
    #[error("audio discontinuity: expected sample {expected}, received {received}; reset required")]
    Discontinuity { expected: u64, received: u64 },
    #[error("third-octave band {band} exceeds the model's 120 dB SPL limit")]
    LevelOutOfRange { band: usize },
    #[error("audio stream ended or failed; reset required")]
    Finished,
    #[error("audio sample counter overflow")]
    SampleCounterOverflow,
}

#[derive(Clone, Debug)]
pub struct LoudnessFrame {
    /// Nominal input-grid time, independent of when the caller receives it.
    pub sample_index: u64,
    pub sones: f64,
    pub specific_sones_per_bark: [f64; SPECIFIC_BINS],
}

impl LoudnessFrame {
    pub fn bands(&self) -> [f32; 24] {
        array::from_fn(|band| {
            (self.specific_sones_per_bark[band * 10..band * 10 + 10]
                .iter()
                .sum::<f64>()
                * 0.1) as f32
        })
    }
}

#[derive(Clone)]
struct ThirdOctave {
    state: [[f64; 2]; 3],
    power: [f64; 3],
    pole: f64,
}

impl ThirdOctave {
    fn new(index: usize) -> Self {
        let frequency = 1000.0 * Float::powf(10.0, (index as f64 - 16.0) / 10.0);
        let tau = 2.0 / (3.0 * frequency.min(1000.0));
        Self {
            state: [[0.0; 2]; 3],
            power: [0.0; 3],
            pole: Float::exp(-1.0 / (SAMPLE_RATE as f64 * tau)),
        }
    }

    fn push(&mut self, mut x: f64, index: usize) {
        for (section, state) in self.state.iter_mut().enumerate() {
            let b1 = [2.0, 0.0, -2.0][section];
            let b2 = [1.0, -1.0, 1.0][section];
            let a1 = -2.0 - tables::FILTER_DIFF[index][section][4];
            let a2 = 1.0 - tables::FILTER_DIFF[index][section][5];
            let y = x + state[0];
            state[0] = b1 * x - a1 * y + state[1];
            state[1] = b2 * x - a2 * y;
            x = y;
        }
        x *= tables::FILTER_GAIN[index];
        x *= x;
        for state in &mut self.power {
            *state = (1.0 - self.pole) * x + self.pole * *state;
            x = *state;
        }
    }

    fn level(&self) -> f64 {
        10.0 * Float::log10((self.power[2] + 1e-12) / 4e-10)
    }
}

/// The model never allocates. It emits each frame once, on a fixed sample grid.
/// The two interpolation stages require 48 input samples of lookahead (1 ms).
#[derive(Clone)]
pub struct LoudnessMeter {
    calibration: Calibration,
    field: SoundField,
    filters: [ThirdOctave; 28],
    temporal: temporal::Temporal,
    previous_core: Option<(u64, [f64; 21])>,
    previous_spectrum: Option<LoudnessFrame>,
    next_sample: u64,
    origin: u64,
    finished: bool,
    clipped_samples: u64,
}

impl LoudnessMeter {
    pub fn new(calibration: Calibration, field: SoundField) -> Self {
        Self {
            calibration,
            field,
            filters: array::from_fn(ThirdOctave::new),
            temporal: temporal::Temporal::new(),
            previous_core: None,
            previous_spectrum: None,
            next_sample: 0,
            origin: 0,
            finished: false,
            clipped_samples: 0,
        }
    }

    pub fn reset(&mut self, first_sample_index: u64) {
        *self = Self::new(self.calibration, self.field);
        self.next_sample = first_sample_index;
        self.origin = first_sample_index;
    }

    pub fn clipped_samples(&self) -> u64 {
        self.clipped_samples
    }

    /// Invalid sample values reject the whole block before changing state.
    /// Domain errors after processing starts invalidate the stream until reset.
    pub fn push_pcm(
        &mut self,
        samples: &[f32],
        first_sample_index: u64,
        mut emit: impl FnMut(LoudnessFrame),
    ) -> Result<(), LoudnessError> {
        if self.finished {
            return Err(LoudnessError::Finished);
        }
        if samples.is_empty() {
            return Err(LoudnessError::EmptyBlock);
        }
        if first_sample_index != self.next_sample {
            return Err(LoudnessError::Discontinuity {
                expected: self.next_sample,
                received: first_sample_index,
            });
        }
        first_sample_index
            .checked_add(samples.len() as u64)
            .ok_or(LoudnessError::SampleCounterOverflow)?;
        for (index, sample) in samples.iter().enumerate() {
            if !sample.is_finite() {
                return Err(LoudnessError::NonFiniteSample { index });
            }
        }
        for &sample in samples {
            self.clipped_samples += u64::from(sample.abs() >= 1.0);
            let pressure = sample as f64 * self.calibration.pascals_per_unit as f64;
            for (band, filter) in self.filters.iter_mut().enumerate() {
                filter.push(pressure, band);
            }
            let index = self.next_sample;
            self.next_sample += 1;
            if (index - self.origin).is_multiple_of(LEVEL_STEP) {
                let levels = array::from_fn(|i| self.filters[i].level());
                let core = match spectrum::core_loudness(&levels, self.field) {
                    Ok(core) => core,
                    Err(error) => {
                        self.finished = true;
                        return Err(error);
                    }
                };
                self.accept_core(index, core, &mut emit);
            }
        }
        Ok(())
    }

    fn accept_core(&mut self, index: u64, core: [f64; 21], emit: &mut impl FnMut(LoudnessFrame)) {
        if let Some((previous_index, previous_core)) = self.previous_core.take() {
            let nonlinear = self.temporal.nonlinear(&previous_core, &core);
            let (sones, specific_sones_per_bark) = spectrum::spread(&nonlinear);
            let next = LoudnessFrame {
                sample_index: previous_index,
                sones,
                specific_sones_per_bark,
            };
            self.accept_spectrum(next, emit);
        }
        self.previous_core = Some((index, core));
    }

    fn accept_spectrum(&mut self, next: LoudnessFrame, emit: &mut impl FnMut(LoudnessFrame)) {
        if let Some(mut previous) = self.previous_spectrum.take() {
            previous.sones = self.temporal.weight(previous.sones, next.sones);
            if (previous.sample_index - self.origin).is_multiple_of(FRAME_SAMPLES) {
                emit(previous);
            }
        }
        self.previous_spectrum = Some(next);
    }

    /// Flush interpolation only at the actual end of a finite signal. This
    /// produces the remaining grid frames; it does not invent a silence tail.
    pub fn finish(&mut self, mut emit: impl FnMut(LoudnessFrame)) -> Result<(), LoudnessError> {
        if self.finished {
            return Err(LoudnessError::Finished);
        }
        if self.previous_core.is_some() {
            self.accept_core(self.next_sample, [0.0; 21], &mut emit);
            self.accept_spectrum(
                LoudnessFrame {
                    sample_index: self.next_sample,
                    sones: 0.0,
                    specific_sones_per_bark: [0.0; SPECIFIC_BINS],
                },
                &mut emit,
            );
        }
        self.finished = true;
        Ok(())
    }
}
