//! Input-level readouts only. These values never feed loudness, gain, or attacks.
use super::{
    loudness::{FRAME_SAMPLES, SAMPLE_RATE},
    settings::AudioSettings,
};
use num::Float;
const BUCKETS: usize = 600;
#[derive(Clone, Copy, Debug)]
pub struct Readout {
    pub rms_dbfs: f64,
    pub background_dbfs: f64,
    pub background_sones: f64,
    pub learning: bool,
}
pub struct Readouts {
    settings: AudioSettings,
    alpha: f64,
    rms_power: f64,
    bucket_power: f64,
    samples: u64,
    sones: f64,
    frames: u64,
    power: [f32; BUCKETS],
    loudness: [f32; BUCKETS],
}
impl Readouts {
    pub fn new(settings: AudioSettings) -> Self {
        Self {
            settings,
            alpha: -Float::exp_m1(-1.0 / (SAMPLE_RATE as f64 * settings.rms_seconds)),
            rms_power: 0.0,
            bucket_power: 0.0,
            samples: 0,
            sones: 0.0,
            frames: 0,
            power: [0.0; BUCKETS],
            loudness: [0.0; BUCKETS],
        }
    }
    pub fn push_pcm(&mut self, pcm: &[f32]) {
        for &value in pcm {
            let power = (value as f64).powi(2);
            self.rms_power += self.alpha * (power - self.rms_power);
            self.bucket_power += power;
            self.samples += 1;
            if self.samples.is_multiple_of(4800) {
                self.power[((self.samples / 4800 - 1) % BUCKETS as u64) as usize] =
                    (self.bucket_power / 4800.0) as f32;
                self.bucket_power = 0.0;
            }
        }
    }
    pub fn push_sones(&mut self, sones: f64) {
        self.sones += sones;
        self.frames += 1;
        if self.frames.is_multiple_of(4800 / FRAME_SAMPLES) {
            self.loudness[((self.frames / 50 - 1) % BUCKETS as u64) as usize] =
                (self.sones / 50.0) as f32;
            self.sones = 0.0;
        }
    }
    pub fn current(&self) -> Readout {
        let available = (self.samples / 4800).min(self.frames / 50) as usize;
        let wanted = Float::round(self.settings.background_seconds * 10.0) as usize;
        let count = available.min(wanted);
        let mut values = [0.0_f32; BUCKETS];
        let percentile = |source: &[f32; BUCKETS], values: &mut [f32; BUCKETS]| {
            if count == 0 {
                return 0.0;
            }
            for (age, out) in values[..count].iter_mut().enumerate() {
                *out = source[(available - 1 - age) % BUCKETS];
            }
            values[..count].sort_unstable_by(|a, b| a.total_cmp(b));
            values[((count - 1) as f64 * self.settings.background_percentile) as usize] as f64
        };
        let power = percentile(&self.power, &mut values);
        let sones = percentile(&self.loudness, &mut values);
        Readout {
            rms_dbfs: dbfs(self.rms_power),
            background_dbfs: dbfs(power),
            background_sones: sones,
            learning: available < wanted,
        }
    }
}
fn dbfs(power: f64) -> f64 {
    10.0 * Float::log10(power.max(1e-16))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pcm_partitions_cannot_change_rms_and_background_is_readout_only() {
        let pcm: std::vec::Vec<f32> = (0..96_000)
            .map(|i| if i < 48_000 { 0.1 } else { 0.5 })
            .collect();
        let mut reference = None;
        for block in [1, 13, 96, 128, 512, 4096] {
            let mut meter = Readouts::new(AudioSettings::default());
            for chunk in pcm.chunks(block) {
                meter.push_pcm(chunk);
            }
            for i in 0..1000 {
                meter.push_sones(if i < 500 { 1.0 } else { 10.0 });
            }
            let value = meter.current();
            let values = [
                value.rms_dbfs,
                value.background_dbfs,
                value.background_sones,
            ];
            if let Some(reference) = reference {
                assert_eq!(values, reference);
            } else {
                reference = Some(values);
            }
            assert!((value.rms_dbfs + 6.0206).abs() < 0.01);
            assert!((value.background_dbfs + 20.0).abs() < 0.001);
            assert_eq!(value.background_sones, 1.0);
            assert!(value.learning);
        }
    }
    #[test]
    fn history_is_bounded_and_new_sources_start_learning_again() {
        let mut values = AudioSettings::default().values();
        values[24] = 1.0;
        let settings = AudioSettings::from_values(&values).unwrap();
        let mut meter = Readouts::new(settings);
        for _ in 0..700 {
            meter.push_pcm(&[0.1; 4800]);
            for _ in 0..50 {
                meter.push_sones(2.0);
            }
        }
        assert!(!meter.current().learning);
        assert_eq!(meter.current().background_sones, 2.0);
        let fresh = Readouts::new(settings).current();
        assert!(fresh.learning);
        assert_eq!(fresh.background_sones, 0.0);
        assert_eq!(fresh.rms_dbfs, -160.0);
    }
}
