//! The single continuous analysis/presentation pipeline used by every display.
use super::{
    loudness::{Calibration, LoudnessError, LoudnessFrame, LoudnessMeter, SAMPLE_RATE, SoundField},
    presentation::{LoudnessPresentation, LoudnessSnapshot},
    settings::AudioSettings,
    tempo::{TempoEstimate, TempoEstimator},
    visual::VisualGain,
};
use crate::lights::dance::RecentPeak;

pub struct ProcessedFrame<'a> {
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
        let Self {
            meter,
            gain,
            presentation,
            tempo,
            peak,
            accent_sequence,
            ..
        } = self;
        meter.push_pcm(samples, first_sample, |frame| {
            let levels = gain.map(&frame);
            presentation.push(&frame, levels, gain.factor(), reduced);
            tempo.push(&presentation.acoustic.novelty);
            let at = frame.sample_index as f64 / SAMPLE_RATE as f64;
            let attack = presentation.acoustic.events.contains(&Some(at));
            let loud = frame.bands().into_iter().fold(0.0_f32, f32::max);
            if peak.push(
                at,
                loud as f64,
                attack,
                presentation.acoustic.candidate_started,
            ) {
                *accent_sequence = accent_sequence.wrapping_add(1);
            }
            emit(ProcessedFrame {
                loudness: &frame,
                snapshot: &presentation.snapshot,
                novelty: &presentation.acoustic.novelty,
                magnitude: &presentation.acoustic.magnitude,
                acoustic_events: &presentation.acoustic.events,
                suppressed: &presentation.suppressed,
            });
        })
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
