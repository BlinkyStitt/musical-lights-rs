//! Continuous jacket analysis. DMA gaps reset the entire acoustic/display state.
use super::{
    loudness::{Calibration, LoudnessError, LoudnessMeter, SAMPLE_RATE, SoundField},
    visual::{DISPLAY_BANDS, DisplaySnapshot, VisualGain},
};

/// Unmeasured 12-bit ADC PCM: midpoint 2048, full-scale magnitude 2048.
pub fn adc_pcm(count: u16) -> f32 {
    (f32::from(count) - 2048.0) / 2048.0
}

pub struct JacketAudio {
    meter: LoudnessMeter,
    gain: VisualGain,
    snapshot: DisplaySnapshot<DISPLAY_BANDS>,
    next_sample: u64,
}
impl Default for JacketAudio {
    fn default() -> Self {
        Self {
            meter: LoudnessMeter::new(Calibration::default(), SoundField::Free),
            gain: VisualGain::default(),
            snapshot: DisplaySnapshot::new(0.0),
            next_sample: 0,
        }
    }
}
impl JacketAudio {
    pub fn reset(&mut self) {
        self.meter.reset(0);
        self.gain = VisualGain::default();
        self.snapshot = DisplaySnapshot::new(0.0);
        self.next_sample = 0;
    }
    pub fn push_adc(&mut self, counts: &[u16]) -> Result<(), LoudnessError> {
        if counts.is_empty() {
            return Err(LoudnessError::EmptyBlock);
        }
        // Bounded scratch storage; DMA read size never defines a model window.
        let mut pcm = [0.0; 96];
        for chunk in counts.chunks(pcm.len()) {
            for (out, &count) in pcm.iter_mut().zip(chunk) {
                *out = adc_pcm(count);
            }
            self.meter
                .push_pcm(&pcm[..chunk.len()], self.next_sample, |frame| {
                    self.snapshot.push(
                        frame.sample_index as f64 / SAMPLE_RATE as f64,
                        self.gain.map(&frame).bands,
                        false,
                    );
                })?;
            self.next_sample += chunk.len() as u64;
        }
        Ok(())
    }
    pub fn snapshot(&self) -> DisplaySnapshot<DISPLAY_BANDS> {
        self.snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adc_midpoint_and_endpoints() {
        assert_eq!(adc_pcm(0), -1.0);
        assert_eq!(adc_pcm(2048), 0.0);
        assert_eq!(adc_pcm(4095), 2047.0 / 2048.0);
    }
    #[test]
    fn every_block_size_retains_shared_loudness_and_targets() {
        let counts: std::vec::Vec<_> = (0..12_000)
            .map(|i| 2048 + if (i / 24) % 2 == 0 { 300 } else { -300 })
            .map(|i| i as u16)
            .collect();
        let pcm: std::vec::Vec<_> = counts.iter().copied().map(adc_pcm).collect();
        let mut meter = LoudnessMeter::new(Calibration::default(), SoundField::Free);
        let mut gain = VisualGain::default();
        let mut expected = DisplaySnapshot::new(0.0);
        meter
            .push_pcm(&pcm, 0, |frame| {
                expected.push(
                    frame.sample_index as f64 / SAMPLE_RATE as f64,
                    gain.map(&frame).bands,
                    false,
                );
            })
            .unwrap();
        for block in [1, 13, 96, 128, 512, 768, 4096] {
            let mut audio = JacketAudio::default();
            for chunk in counts.chunks(block) {
                audio.push_adc(chunk).unwrap();
            }
            assert_eq!(audio.snapshot(), expected, "block size {block}");
        }
    }
    #[test]
    fn a_dma_gap_clears_gain_targets_and_acoustic_edges() {
        let mut audio = JacketAudio::default();
        audio.push_adc(&[2300; 3000]).unwrap();
        assert!(audio.snapshot().frame(0.05).edges.iter().any(|v| *v > 0.0));
        audio.reset();
        assert_eq!(audio.snapshot(), JacketAudio::default().snapshot());
        let after = [1900; 3000];
        audio.push_adc(&after).unwrap();
        let mut fresh = JacketAudio::default();
        fresh.push_adc(&after).unwrap();
        assert_eq!(audio.snapshot(), fresh.snapshot());
    }
}
