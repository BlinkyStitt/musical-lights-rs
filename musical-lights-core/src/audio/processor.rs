//! The single continuous analysis/presentation pipeline used by every display.
use super::{
    loudness::{Calibration, LoudnessError, LoudnessFrame, LoudnessMeter, SAMPLE_RATE, SoundField},
    policy::{MicrophoneGate, VisualOptions},
    presentation::{LoudnessPresentation, LoudnessSnapshot},
    settings::AudioSettings,
    tempo::{TempoEstimate, TempoEstimator},
    visual::VisualGain,
};
use crate::lights::dance::RecentPeak;

pub struct ProcessedFrame<'a> {
    pub settings: AudioSettings,
    pub options: VisualOptions,
    pub revision: u32,
    pub loudness: &'a LoudnessFrame,
    pub snapshot: &'a LoudnessSnapshot,
    pub novelty: &'a [f64; 24],
    pub magnitude: &'a [f64; 24],
    pub acoustic_events: &'a [Option<f64>; 24],
    pub suppressed: &'a [u32; 24],
}
pub struct LoudnessProcessor {
    meter: LoudnessMeter,
    gain: VisualGain,
    presentation: LoudnessPresentation,
    tempo: TempoEstimator,
    peak: RecentPeak,
    accent_sequence: u32,
    settings: AudioSettings,
    options: VisualOptions,
    gate: MicrophoneGate,
    microphone: bool,
    chunk_phase: usize,
    revision: u32,
    pending: Option<(u32, AudioSettings, VisualOptions)>,
}
impl LoudnessProcessor {
    pub fn new(calibration: Calibration, field: SoundField, settings: AudioSettings) -> Self {
        Self {
            meter: LoudnessMeter::new(calibration, field),
            gain: VisualGain::new(settings),
            presentation: LoudnessPresentation::new(0.0, settings),
            tempo: TempoEstimator::new(settings),
            peak: RecentPeak::default(),
            accent_sequence: 0,
            settings,
            options: VisualOptions::default(),
            gate: MicrophoneGate::default(),
            microphone: false,
            chunk_phase: 0,
            revision: 0,
            pending: None,
        }
    }
    pub fn reset(&mut self, first_sample: u64) {
        self.meter.reset(first_sample);
        self.gain = VisualGain::new(self.settings);
        self.presentation =
            LoudnessPresentation::new(first_sample as f64 / SAMPLE_RATE as f64, self.settings);
        self.tempo = TempoEstimator::new(self.settings);
        self.peak = RecentPeak::default();
        self.accent_sequence = 0;
        self.gate = MicrophoneGate::default();
        self.gate.set_threshold(self.options.gate_dbfs);
        self.gain.configure(self.settings, self.options);
        self.chunk_phase = 0;
    }
    pub fn set_microphone(&mut self, microphone: bool) {
        self.microphone = microphone;
    }
    pub fn revision(&self) -> u32 {
        self.revision
    }
    pub fn queue_settings(
        &mut self,
        revision: u32,
        settings: AudioSettings,
        options: VisualOptions,
    ) -> bool {
        if revision == 0
            || revision <= self.pending.map_or(self.revision, |p| p.0)
            || VisualOptions::from_values(&options.values()).is_none()
        {
            return false;
        }
        self.pending = Some((revision, settings, options));
        true
    }
    pub fn snapshot(&self) -> LoudnessSnapshot {
        self.presentation.snapshot
    }
    pub fn tempo(&self) -> TempoEstimate {
        self.tempo.estimate()
    }
    pub fn accent_sequence(&self) -> u32 {
        self.accent_sequence
    }
    pub fn push_pcm(
        &mut self,
        samples: &[f32],
        first_sample: u64,
        reduced: bool,
        mut emit: impl FnMut(ProcessedFrame<'_>),
    ) -> Result<(), LoudnessError> {
        // Validate the complete callback before advancing detector or meter state.
        if samples.is_empty() {
            return Err(LoudnessError::EmptyBlock);
        }
        if let Some(index) = samples.iter().position(|v| !v.is_finite()) {
            return Err(LoudnessError::NonFiniteSample { index });
        }
        let Self {
            meter,
            gain,
            presentation,
            tempo,
            peak,
            accent_sequence,
            settings,
            options,
            gate,
            microphone,
            chunk_phase,
            revision,
            pending,
        } = self;
        let mut offset = 0;
        while offset < samples.len() {
            // The ISO meter emits after a fixed interpolation delay. Feed it on
            // its 24-sample grid so gate state cannot depend on callback length.
            // Meter grid indices include the sample at the start of each step.
            let until_grid = if *chunk_phase == 0 {
                1
            } else {
                25 - *chunk_phase
            };
            let count = until_grid.min(samples.len() - offset);
            let pcm = &samples[offset..offset + count];
            gate.push(pcm);
            meter.push_pcm(pcm, first_sample + offset as u64, |frame| {
                let changed = if let Some((next, tuning, visual)) = pending.take() {
                    *settings = tuning;
                    *options = visual;
                    *revision = next;
                    gain.configure(tuning, visual);
                    presentation.configure(tuning);
                    tempo.configure(tuning);
                    gate.set_threshold(visual.gate_dbfs);
                    true
                } else {
                    false
                };
                let closed = *microphone && options.gate_enabled && !gate.is_open();
                let levels = gain.map_gated(&frame, closed);
                presentation.push_policy(
                    &frame,
                    levels,
                    gain.factor(),
                    reduced,
                    !closed && !changed,
                );
                tempo.push(if closed {
                    &[0.0; 24]
                } else {
                    &presentation.acoustic.novelty
                });
                let at = frame.sample_index as f64 / SAMPLE_RATE as f64;
                let attack =
                    !closed && !changed && presentation.acoustic.events.contains(&Some(at));
                let loud = frame.bands().into_iter().fold(0.0_f32, f32::max);
                if peak.push(
                    at,
                    loud as f64,
                    attack,
                    !closed && !changed && presentation.acoustic.candidate_started,
                ) {
                    *accent_sequence = accent_sequence.wrapping_add(1);
                }
                emit(ProcessedFrame {
                    settings: *settings,
                    options: *options,
                    revision: *revision,
                    loudness: &frame,
                    snapshot: &presentation.snapshot,
                    novelty: &presentation.acoustic.novelty,
                    magnitude: &presentation.acoustic.magnitude,
                    acoustic_events: &presentation.acoustic.events,
                    suppressed: &presentation.suppressed,
                });
            })?;
            *chunk_phase = (*chunk_phase + count) % 24;
            offset += count;
        }
        Ok(())
    }
}
impl Default for LoudnessProcessor {
    fn default() -> Self {
        Self::new(
            Calibration::default(),
            SoundField::Free,
            AudioSettings::default(),
        )
    }
}
