//! Causal tempo from the existing spectral novelty; no PCM/model changes.
//! Ellis (2007) onset autocorrelation, with bounded history as in causal BTrack.
//! This estimates tempo, not beat phase or the paper's dynamic-programming path.
use micromath::F32Ext;

pub const ENVELOPE_HZ: usize = 50;
pub const HISTORY: usize = ENVELOPE_HZ * 8;
pub const FALLBACK_BPM: f32 = 120.0;

#[derive(Clone, Copy, Debug)]
pub struct TempoEstimate {
    pub bpm: f32,
    pub confidence: f32,
}

/// Fixed 1.6 KiB envelope; bounded evaluation every 25 bins, no heap use.
pub struct TempoEstimator {
    envelope: [f32; HISTORY],
    bins: usize,
    elapsed: f32,
    aggregate: f32,
    accepted: f32,
    established: bool,
    smoothed: f32,
    confidence: f32,
    lost_seconds: f32,
}
impl Default for TempoEstimator {
    fn default() -> Self {
        Self {
            envelope: [0.0; HISTORY],
            bins: 0,
            elapsed: 0.0,
            aggregate: 0.0,
            accepted: FALLBACK_BPM,
            established: false,
            smoothed: FALLBACK_BPM,
            confidence: 0.0,
            lost_seconds: 0.0,
        }
    }
}
impl TempoEstimator {
    /// One production 2 ms novelty frame. Scaling novelty cannot change tempo.
    pub fn push(&mut self, novelty: &[f64]) {
        let value = novelty.iter().copied().sum::<f64>();
        self.aggregate += if value.is_finite() {
            value.clamp(0.0, 1e12) as f32
        } else {
            0.0
        };
        self.elapsed += 0.002;
        if self.elapsed < 0.020 - 1e-6 {
            return;
        }
        self.elapsed -= 0.020;
        self.envelope[self.bins % HISTORY] = self.aggregate;
        self.aggregate = 0.0;
        self.bins = self.bins.wrapping_add(1);
        if self.bins >= ENVELOPE_HZ * 4 && self.bins.is_multiple_of(25) {
            self.evaluate();
        }
        if self.confidence > 0.0 {
            self.lost_seconds = 0.0;
        } else {
            self.lost_seconds += 0.020;
        }
        let target = if self.lost_seconds > 2.0 {
            FALLBACK_BPM
        } else {
            self.accepted
        };
        self.smoothed += (target - self.smoothed) * (1.0 - F32Ext::exp(-0.020 / 3.0));
    }
    pub fn estimate(&self) -> TempoEstimate {
        TempoEstimate {
            bpm: self.smoothed,
            confidence: self.confidence,
        }
    }
    fn sample(&self, age: usize) -> f32 {
        self.envelope[(self.bins - 1 - age) % HISTORY]
    }
    fn evaluate(&mut self) {
        let n = self.bins.min(HISTORY);
        let mean = (0..n).map(|i| self.sample(i)).sum::<f32>() / n as f32;
        let energy = (0..n).map(|i| (self.sample(i) - mean).powi(2)).sum::<f32>();
        let recent = (0..50).map(|i| self.sample(i)).sum::<f32>();
        if energy < 1e-12 || recent < mean * 5.0 || recent < 1e-9 {
            self.confidence = 0.0;
            return;
        }
        // Compute normalized, mean-centered correlation once per integer lag.
        let mut correlations = [0.0_f32; 51];
        for (lag, correlation) in correlations.iter_mut().enumerate().skip(15) {
            let (mut cross, mut a2, mut b2) = (0.0, 0.0, 0.0);
            for i in lag..n {
                let a = self.sample(i) - mean;
                let b = self.sample(i - lag) - mean;
                cross += a * b;
                a2 += a * a;
                b2 += b * b;
            }
            *correlation = cross / F32Ext::sqrt(a2 * b2).max(1e-12);
        }
        let mut best = (0.0_f32, FALLBACK_BPM, 0.0_f32);
        let mut sum = 0.0;
        for bpm in 60..=200 {
            let lag = 3000.0 / bpm as f32;
            let lower = lag as usize;
            let fraction = lag - lower as f32;
            let correlation = correlations[lower] * (1.0 - fraction)
                + correlations[(lower + 1).min(50)] * fraction;
            sum += correlation.max(0.0);
            // Similar octave peaks keep the previous interpretation; the initial
            // interpretation favors 120 BPM. Stronger evidence still wins.
            let continuity = 1.0 / (1.0 + F32Ext::abs(F32Ext::ln(bpm as f32 / self.accepted)));
            // Suppress slower integer multiples when the shorter period also
            // explains the envelope (including the common octave ambiguity).
            let mut harmonic = 1.0;
            for divisor in [2.0, 3.0] {
                let sublag = lag / divisor;
                if sublag >= 15.0 {
                    let k = sublag as usize;
                    let sub = correlations[k].max(correlations[(k + 1).min(50)]);
                    if sub > correlation * 0.7
                        && !(self.established && (bpm as f32 / self.accepted - 1.0).abs() < 0.08)
                    {
                        harmonic = 0.7;
                    }
                }
            }
            let score = correlation * (0.85 + 0.15 * continuity) * harmonic;
            if score > best.0 {
                best = (score, bpm as f32, correlation);
            }
        }
        if best.2 >= 0.45 && best.2 - sum / 141.0 >= 0.12 {
            self.accepted = best.1;
            self.established = true;
            self.confidence = best.2.clamp(0.0, 1.0);
        } else {
            self.confidence = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn feed(t: &mut TempoEstimator, bpm: f64, seconds: usize) {
        for i in 0..seconds * 500 {
            let phase = (i as f64 * 0.002 * bpm / 60.0).fract();
            let mut novelty = [0.0; 24];
            novelty[0] = if phase < 0.04 { 1.0 } else { 0.0 };
            t.push(&novelty);
        }
    }
    #[test]
    fn click_tempos_and_octave_continuity() {
        for bpm in [60.0, 75.0, 90.0, 100.0, 120.0, 150.0, 180.0, 200.0] {
            let mut t = TempoEstimator::default();
            feed(&mut t, bpm, 24);
            let e = t.estimate();
            assert!(e.confidence > 0.45, "{bpm}: {e:?}");
            assert!((e.bpm - bpm as f32).abs() < 4.0, "{bpm}: {e:?}");
        }
    }
    #[test]
    fn subdivision_does_not_flip_an_established_octave() {
        let mut t = TempoEstimator::default();
        feed(&mut t, 60.0, 24);
        for i in 0..12_000 {
            let phase = (i as f64 * 0.002).fract();
            let mut novelty = [0.0; 24];
            novelty[0] = if phase < 0.04 {
                1.0
            } else if (0.5..0.54).contains(&phase) {
                0.75
            } else {
                0.0
            };
            t.push(&novelty);
        }
        assert!((t.estimate().bpm - 60.0).abs() < 4.0);
    }
    #[test]
    fn silence_noise_and_loss_return_to_fallback() {
        let mut t = TempoEstimator::default();
        feed(&mut t, 150.0, 24);
        let previous = t.estimate().bpm;
        for _ in 0..500 {
            t.push(&[0.0; 24]);
        }
        assert!((t.estimate().bpm - previous).abs() < 1.0);
        for _ in 0..12000 {
            t.push(&[0.0; 24]);
        }
        assert_eq!(t.estimate().confidence, 0.0);
        assert!((t.estimate().bpm - 120.0).abs() < 0.1);
        let mut seed = 42_u32;
        for _ in 0..12000 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            t.push(&[f64::from(seed) / f64::from(u32::MAX); 24]);
        }
        assert_eq!(t.estimate().confidence, 0.0);
    }
    #[test]
    fn follows_change_without_jump() {
        let mut t = TempoEstimator::default();
        feed(&mut t, 100.0, 24);
        let before = t.estimate().bpm;
        feed(&mut t, 150.0, 1);
        assert!((t.estimate().bpm - before).abs() < 5.0);
        feed(&mut t, 150.0, 24);
        assert!((t.estimate().bpm - 150.0).abs() < 4.0);
    }
}
