//! A cascaded Bark filter bank for normalized mono PCM.
//!
//! The weighting, power-law compression, per-band adaptive floor/peak, and
//! summed bass output are visual approximations, not a calibrated loudness model.
use super::AggregatedBins;
use biquad::{Biquad, Coefficients, DirectForm2Transposed, ToHertz, Type};
use core::array;
use num::Float;
use thiserror::Error;

pub const BARK_BANDS: usize = 24;
pub const BASS_BANDS: usize = 5;
/// The lowest five analysis bands share one display output.
pub const DISPLAY_BANDS: usize = BARK_BANDS - BASS_BANDS + 1;
const Q_BOOST: f32 = 3.0;
const BARK_EDGES: [f32; BARK_BANDS + 1] = [
    0.0, 100.0, 200.0, 300.0, 400.0, 510.0, 630.0, 770.0, 920.0, 1080.0, 1270.0, 1480.0, 1720.0,
    2000.0, 2320.0, 2700.0, 3150.0, 3700.0, 4400.0, 5300.0, 6400.0, 7700.0, 9500.0, 12_000.0,
    15_500.0,
];
/// Empirical frequency weights retained from the original visualizer.
const LOUDNESS_GAIN: [f32; BARK_BANDS] = [
    0.0891, 0.1259, 0.1585, 0.1995, 0.2985, 0.3548, 0.4217, 0.4729, 0.5311, 0.5964, 0.6309, 0.6683,
    0.7079, 0.7499, 0.7943, 0.8412, 0.8909, 0.9433, 1.0000, 1.1220, 1.2589, 1.4125, 1.6768, 2.1060,
];

#[derive(Debug, Clone, Copy, PartialEq, Error)]
pub enum AudioError {
    #[error("sample rate must be finite and greater than 31000 Hz")]
    InvalidSampleRate,
    #[error("audio block is empty")]
    EmptyBlock,
    #[error("sample {index} is not finite")]
    NonFiniteSample { index: usize },
    #[error("sample {index} is outside normalized PCM range [-1, 1]")]
    SampleOutOfRange { index: usize },
    #[error("cannot construct filter for band {band}")]
    InvalidFilter { band: usize },
}

/// Attack/release state retains fractional values until the display conversion.
#[derive(Clone, Copy, Debug)]
pub struct Envelope {
    value: f32,
    attack_s: f32,
    release_s: f32,
}
impl Envelope {
    pub const fn new(attack_s: f32, release_s: f32, initial: f32) -> Self {
        Self {
            value: initial,
            attack_s,
            release_s,
        }
    }

    /// Advance by the elapsed duration in seconds. A zero time constant is instant.
    pub fn update(&mut self, input: f32, elapsed_s: f32) -> f32 {
        let tau = if input > self.value {
            self.attack_s
        } else {
            self.release_s
        };
        let alpha = if tau <= 0.0 {
            0.0
        } else {
            Float::exp(-elapsed_s / tau)
        };
        self.value = alpha * self.value + (1.0 - alpha) * input;
        self.value
    }
}

#[derive(Clone)]
struct BandState {
    filter1: DirectForm2Transposed<f32>,
    filter2: DirectForm2Transposed<f32>,
    peak: Envelope,
    floor: Envelope,
    value: f32,
}

#[derive(Clone)]
pub struct BarkBank {
    bands: [BandState; BARK_BANDS],
    sample_hz: f32,
}

fn center_and_q(band: usize) -> (f32, f32) {
    let (lo, hi) = (BARK_EDGES[band], BARK_EDGES[band + 1]);
    let center = if lo > 0.0 {
        Float::sqrt(lo * hi)
    } else {
        hi * 0.5
    };
    (center, center / (hi - lo) * Q_BOOST)
}

fn coefficients(band: usize, sample_hz: f32) -> Result<Coefficients<f32>, AudioError> {
    let (center, q) = center_and_q(band);
    let mut c = Coefficients::from_params(Type::BandPass, sample_hz.hz(), center.hz(), q)
        .map_err(|_| AudioError::InvalidFilter { band })?;
    // biquad's band-pass numerator has center gain Q. Normalize each stage;
    // retain the original poles, bandwidth, and two-stage cascade.
    c.b0 /= q;
    c.b1 /= q;
    c.b2 /= q;
    if ![c.a1, c.a2, c.b0, c.b1, c.b2]
        .iter()
        .all(|value| value.is_finite())
        || c.a2.abs() >= 1.0
        || 1.0 + c.a1 + c.a2 <= 0.0
        || 1.0 - c.a1 + c.a2 <= 0.0
    {
        return Err(AudioError::InvalidFilter { band });
    }
    Ok(c)
}

fn normalize(value: f32, floor: f32, peak: f32) -> f32 {
    let range = peak - floor;
    if value <= floor || range <= 0.0 {
        0.0
    } else {
        ((value - floor) / range).clamp(0.0, 1.0)
    }
}

impl BarkBank {
    /// All band edges must remain below Nyquist. No nominal frame rate is needed.
    pub fn new(sample_hz: f32) -> Result<Self, AudioError> {
        if !sample_hz.is_finite() || sample_hz <= 2.0 * BARK_EDGES[BARK_BANDS] {
            return Err(AudioError::InvalidSampleRate);
        }
        let mut filters = [coefficients(0, sample_hz)?; BARK_BANDS];
        for (band, c) in filters.iter_mut().enumerate() {
            *c = coefficients(band, sample_hz)?;
        }
        Ok(Self {
            sample_hz,
            bands: array::from_fn(|band| {
                let filter = DirectForm2Transposed::new(filters[band]);
                BandState {
                    filter1: filter,
                    filter2: filter,
                    peak: Envelope::new(0.022, 10.0, 2.0),
                    floor: Envelope::new(10.0, 0.0, 0.0),
                    value: 0.0,
                }
            }),
        })
    }

    /// Validate the entire block before changing filter or envelope state.
    pub fn push_samples(
        &mut self,
        pcm: &[f32],
    ) -> Result<AggregatedBins<DISPLAY_BANDS>, AudioError> {
        if pcm.is_empty() {
            return Err(AudioError::EmptyBlock);
        }
        for (index, sample) in pcm.iter().enumerate() {
            if !sample.is_finite() {
                return Err(AudioError::NonFiniteSample { index });
            }
            if sample.abs() > 1.0 {
                return Err(AudioError::SampleOutOfRange { index });
            }
        }
        let elapsed_s = pcm.len() as f32 / self.sample_hz;
        let inv_n = 1.0 / pcm.len() as f32;
        for (band, st) in self.bands.iter_mut().enumerate() {
            let mut mean_square = 0.0;
            for &x in pcm {
                let y = st.filter2.run(st.filter1.run(x));
                mean_square += y * y * inv_n;
            }
            st.value = Float::powf(Float::sqrt(mean_square) * LOUDNESS_GAIN[band], 0.23);
            st.peak.update(st.value, elapsed_s);
            st.floor.update(st.value, elapsed_s);
        }
        // Advance the filters and envelopes through silence, but display zero.
        if pcm.iter().all(|&x| x == 0.0) {
            return Ok(AggregatedBins::new());
        }
        Ok(self.outputs())
    }

    fn outputs(&self) -> AggregatedBins<DISPLAY_BANDS> {
        let mut output = [0.0; DISPLAY_BANDS];
        let (mut value, mut floor, mut peak) = (0.0, 0.0, 0.0);
        for st in &self.bands[..BASS_BANDS] {
            value += st.value;
            floor += st.floor.value;
            peak += st.peak.value;
        }
        output[0] = normalize(value, floor, peak.max(floor * 2.0));
        for (out, st) in output[1..].iter_mut().zip(&self.bands[BASS_BANDS..]) {
            *out = normalize(
                st.value,
                st.floor.value,
                st.peak.value.max(st.floor.value * 2.0),
            );
        }
        AggregatedBins(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_complex::Complex64;

    fn response(c: Coefficients<f32>, frequency: f64, rate: f64) -> f64 {
        let z = Complex64::from_polar(1.0, -core::f64::consts::TAU * frequency / rate);
        ((c.b0 as f64 + z * c.b1 as f64 + z * z * c.b2 as f64)
            / (1.0 + z * c.a1 as f64 + z * z * c.a2 as f64))
            .norm()
    }

    #[test]
    fn filter_centers_and_unity_gain_at_both_sample_rates() {
        for rate in [44_100.0, 48_000.0] {
            for band in 0..BARK_BANDS {
                let c = coefficients(band, rate).unwrap();
                let (center, _) = center_and_q(band);
                let gain = response(c, center as f64, rate as f64);
                assert!(
                    (gain - 1.0).abs() < 0.001,
                    "rate={rate} band={band} gain={gain}"
                );
                assert!(response(c, center as f64 * 0.9, rate as f64) < gain);
                assert!(response(c, center as f64 * 1.1, rate as f64) < gain);
                assert_eq!(response(c, 0.0, rate as f64), 0.0);
            }
        }
    }

    #[test]
    fn mapping_sums_five_bass_bands_then_keeps_each_remaining_band() {
        let mut bank = BarkBank::new(48_000.0).unwrap();
        for (i, band) in bank.bands.iter_mut().enumerate() {
            band.value = (i + 1) as f32 / 24.0;
            band.floor.value = 0.0;
            band.peak.value = 1.0;
        }
        let output: AggregatedBins<20> = bank.outputs();
        assert!((output.0[0] - 3.0 / 24.0).abs() < 1e-6);
        for (index, &value) in output.0.iter().enumerate().skip(1) {
            assert_eq!(value, (index + BASS_BANDS) as f32 / 24.0);
        }
    }

    #[test]
    fn rejects_invalid_rates_and_samples_without_state_changes() {
        for rate in [0.0, -1.0, 31_000.0, f32::NAN, f32::INFINITY] {
            assert!(matches!(
                BarkBank::new(rate),
                Err(AudioError::InvalidSampleRate)
            ));
        }
        let mut bank = BarkBank::new(44_100.0).unwrap();
        bank.push_samples(&[0.5; 128]).unwrap();
        let mut control = bank.clone();
        assert_eq!(bank.push_samples(&[]).unwrap_err(), AudioError::EmptyBlock);
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(
                bank.push_samples(&[0.25, value]).unwrap_err(),
                AudioError::NonFiniteSample { index: 1 }
            );
        }
        for value in [-1.001, 1.001, f32::MAX] {
            assert_eq!(
                bank.push_samples(&[0.25, value]).unwrap_err(),
                AudioError::SampleOutOfRange { index: 1 }
            );
        }
        assert!(BarkBank::new(f32::MAX).is_err());
        assert_eq!(
            bank.push_samples(&[0.25; 256]).unwrap().0,
            control.push_samples(&[0.25; 256]).unwrap().0
        );
    }

    #[test]
    fn silence_and_zero_normalization_range_are_zero() {
        let mut bank = BarkBank::new(48_000.0).unwrap();
        assert_eq!(
            bank.push_samples(&[0.0; 128]).unwrap().0,
            [0.0; DISPLAY_BANDS]
        );
        bank.push_samples(&[1.0; 128]).unwrap();
        assert_eq!(
            bank.push_samples(&[0.0; 128]).unwrap().0,
            [0.0; DISPLAY_BANDS]
        );
        assert_eq!(normalize(0.0, 0.0, 0.0), 0.0);
        assert_eq!(normalize(1.0, 1.0, 1.0), 0.0);
    }

    #[test]
    fn real_blocks_produce_finite_bounded_output() {
        for rate in [44_100.0, 48_000.0] {
            let mut bank = BarkBank::new(rate).unwrap();
            for frame in 0..100 {
                let samples: [f32; 128] = array::from_fn(|i| {
                    (core::f32::consts::TAU * 1000.0 * (frame * 128 + i) as f32 / rate).sin()
                });
                let output = bank.push_samples(&samples).unwrap();
                assert!(
                    output
                        .0
                        .iter()
                        .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
                );
            }
        }
    }

    #[test]
    fn envelope_timing_depends_on_duration_and_led_decay_does_not_stall() {
        for rate in [44_100.0, 48_000.0] {
            let mut full = Envelope::new(0.022, 0.12, 0.0);
            let mut split = full;
            full.update(128.0, 480.0 / rate);
            for _ in 0..4 {
                split.update(128.0, 120.0 / rate);
            }
            assert!((full.value - split.value).abs() < 0.001);
            let mut led = Envelope::new(0.0, 0.12, 9.0);
            for _ in 0..200 {
                led.update(8.0, 1.0 / 55.5);
            }
            assert!((led.value - 8.0).abs() < 0.0001);
            assert_eq!(led.value.round() as u8, 8);
            for _ in 0..200 {
                led.update(0.0, 1.0 / 55.5);
            }
            assert_eq!(led.value.round() as u8, 0);
        }
    }
}
