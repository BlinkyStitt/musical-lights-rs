//! Continuous jacket analysis. DMA gaps reset the entire acoustic/display state.
use super::{
    loudness::LoudnessError, presentation::LoudnessSnapshot, processor::LoudnessProcessor,
};

/// Unmeasured 12-bit ADC PCM: midpoint 2048, full-scale magnitude 2048.
pub fn adc_pcm(count: u16) -> f32 {
    (f32::from(count) - 2048.0) / 2048.0
}

#[derive(Default)]
pub struct JacketAudio {
    processor: LoudnessProcessor,
    next_sample: u64,
}
impl JacketAudio {
    pub fn reset(&mut self) {
        self.processor.reset(0);
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
            self.processor
                .push_pcm(&pcm[..chunk.len()], self.next_sample, false, |_| {})?;
            self.next_sample += chunk.len() as u64;
        }
        Ok(())
    }
    pub fn snapshot(&self) -> LoudnessSnapshot {
        self.processor.snapshot()
    }
}
