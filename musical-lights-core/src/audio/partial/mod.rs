// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted from loudness, Copyright (C) 2014 Dominic Ward.
//! Source-band partial loudness: MGB1997 with GM2002 short-term integration.
//!
//! The 24 sources are disjoint FFT frequency slices, not auditory filters.
//! Their partial loudness does not sum to ISO 532-1 total loudness. The latter
//! remains a separate, unchanged measurement. Causal periodic Hann analysis:
//! 2048 samples, 96-sample hop, zero history at session start, no lookahead.
//!
//! Equations and reference-compatible coefficients adapted from Dominic Ward's
//! loudness, revision 82de790f79c5b358040861e8bdb906a55009b117 (GPL-3.0-or-later).
//! See THIRD_PARTY_NOTICES.md and validation/partial for independent checks.
// Retain the reference's published decimal coefficients and generated tables.
#![allow(clippy::excessive_precision)]
use super::{
    loudness::{Calibration, LoudnessError, SAMPLE_RATE},
    visual::BARK_EDGES,
};
use num::Float;
mod weights;

pub const WINDOW: usize = 2048;
pub const HOP: usize = 96;
pub const BINS: usize = 853; // FFT bins 1..=853: 23.4375..19992.1875 Hz.
pub const FILTERS: usize = 149; // 1.8..38.8 Cam, spacing 0.25.
const SOURCES: usize = 25; // The last source is the audible background above 15.5 kHz.
const SPACING: f64 = 0.25;
const ATTACK: f64 = 1.0 - 0.955 * 0.955;
const RELEASE: f64 = 1.0 - 0.98 * 0.98;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PartialLoudnessFrame {
    /// End-exclusive sample clock. Window support is [sample_index-2048, sample_index).
    pub sample_index: u64,
    pub instantaneous_sones: [f64; 24],
    pub short_term_sones: [f64; 24],
}

#[derive(Clone, Copy, Default)]
struct Filter {
    inverse_frequency: f64,
    upper: f64,
    lower: f64,
    threshold: f64,
    gain: f64,
    a: f64,
    alpha: f64,
    k: f64,
    a_power: f64,
    quiet_power: f64,
}
fn frequency(bin: usize) -> f64 {
    (bin + 1) as f64 * SAMPLE_RATE as f64 / WINDOW as f64
}
fn cam(f: f64) -> f64 {
    21.366 * Float::log10(0.004368 * f + 1.0)
}
fn hertz(cam: f64) -> f64 {
    (Float::powf(10.0_f64, cam / 21.366) - 1.0) / 0.004368
}
fn erb(f: f64) -> f64 {
    24.673 * (0.004368 * f + 1.0)
}
fn power(db: f64) -> f64 {
    Float::powf(10.0_f64, db / 10.0)
}
impl Filter {
    fn new(f: f64) -> Self {
        let l = Float::log10(f.max(50.0));
        let quiet_db = if f >= 500.0 {
            3.73
        } else {
            power(
                10.0 * (0.43068810954936998 * l * l * l - 2.7976098820730675 * l * l
                    + 5.073846033569697 * l
                    - 1.2060617476790148),
            )
        };
        let gd = 3.73 - quiet_db;
        let a = if gd >= 0.0 {
            4.72096
        } else {
            ((((-0.0000010706497192096045 * gd - 0.000060648487122230512) * gd
                - 0.0012047326575717733)
                * gd
                - 0.0068190417911848525)
                * gd
                - 0.11847825641628305)
                * gd
                + 4.713872246349735
        };
        let alpha = if gd >= 0.0 {
            0.2
        } else {
            0.000026864285714285498 * gd * gd - 0.0020023357142857231 * gd + 0.19993107142857139
        };
        let kd = if f >= 1000.0 {
            -3.0
        } else {
            (((4.4683421395470813 * l - 49.680265975480935) * l + 212.89091871289099) * l
                - 418.88552055717832)
                * l
                + 317.07466358701885
        };
        let gain = power(gd);
        let threshold = power(quiet_db);
        let upper = 4.0 * f / erb(f);
        Self {
            inverse_frequency: 1.0 / f,
            upper,
            lower: 0.35 * upper / (4000.0 / erb(1000.0)),
            threshold,
            gain,
            a,
            alpha,
            k: power(kd),
            a_power: Float::powf(a, alpha),
            quiet_power: Float::powf(threshold * gain + a, alpha),
        }
    }
    fn partial(self, signal: f64, total: f64) -> f64 {
        if signal <= 1e-10 {
            return 0.0;
        } // Published reference's numerical zero.
        let noise = (total - signal).max(0.0);
        let threshold = self.k * noise + self.threshold;
        let c = 0.046871;
        if total > 1e10 {
            let c2 = c / Float::sqrt(1040000.0_f64);
            if signal >= threshold {
                c2 * (Float::powf(total, 0.5)
                    - (Float::powf(noise + threshold, 0.5) - self.quiet_power + self.a_power)
                        * Float::powf(threshold / signal, 0.3))
            } else {
                c * Float::powf(2.0 * signal / (signal + threshold), 1.5)
                    * (self.quiet_power - self.a_power)
                    / (Float::powf(noise + threshold, 0.5) - Float::powf(noise, 0.5))
                    * (Float::powf(total, 0.5) - Float::powf(noise, 0.5))
            }
        } else if signal >= threshold {
            c * (Float::powf(total * self.gain + self.a, self.alpha)
                - self.a_power
                - (Float::powf(self.gain * (noise + threshold) + self.a, self.alpha)
                    - self.quiet_power)
                    * Float::powf(threshold / signal, 0.3))
        } else {
            let background = Float::powf(noise * self.gain + self.a, self.alpha);
            c * Float::powf(2.0 * signal / (signal + threshold), 1.5)
                * (self.quiet_power - self.a_power)
                / (Float::powf((noise + threshold) * self.gain + self.a, self.alpha) - background)
                * (Float::powf(total * self.gain + self.a, self.alpha) - background)
        }
    }
}

/// Preallocated spectral stages. The same mixture determines every source's
/// filter shape. Exposed stage arrays support independent offline validation.
/// No thresholds, sharpening, or per-source gain are applied to the result.
pub struct PartialSpectrum {
    bands: [usize; BINS],
    rectangles: [(usize, usize); BINS],
    filters: [Filter; FILTERS],
    roex: [f64; 1024],
    pub weighted: [f64; BINS],
    pub excitation: [[f64; FILTERS]; SOURCES],
    pub specific: [[f64; FILTERS]; 24],
    short_term: [f64; 24],
}
impl Default for PartialSpectrum {
    fn default() -> Self {
        Self {
            bands: core::array::from_fn(|i| {
                BARK_EDGES[1..]
                    .iter()
                    .position(|&edge| frequency(i) < edge as f64)
                    .unwrap_or(24)
            }),
            rectangles: core::array::from_fn(|i| {
                let c = cam(frequency(i));
                let low = hertz(c - 0.5);
                let high = hertz(c + 0.5);
                (
                    (0..BINS).find(|&j| frequency(j) >= low).unwrap_or(i),
                    (0..BINS).find(|&j| frequency(j) > high).unwrap_or(BINS),
                )
            }),
            filters: core::array::from_fn(|i| Filter::new(hertz(1.8 + i as f64 * SPACING))),
            roex: core::array::from_fn(|i| {
                let pg = i as f64 * 0.02;
                (1.0 + pg) * Float::exp(-pg)
            }),
            weighted: [0.0; BINS],
            excitation: [[0.0; FILTERS]; SOURCES],
            specific: [[0.0; FILTERS]; 24],
            short_term: [0.0; 24],
        }
    }
}
impl PartialSpectrum {
    /// Power in each positive-frequency FFT bin, relative to (20 µPa)^2.
    /// Call every 2 ms. This input surface is also used by the offline oracle.
    pub fn process(&mut self, spectrum: &[f64; BINS], sample_index: u64) -> PartialLoudnessFrame {
        let mut prefix = [0.0; BINS + 1];
        for i in 0..BINS {
            self.weighted[i] = spectrum[i] * weights::EAR_POWER[i];
            prefix[i + 1] = prefix[i] + self.weighted[i];
        }
        let levels: [f64; BINS] = core::array::from_fn(|i| {
            let (low, high) = self.rectangles[i];
            10.0 * Float::log10((prefix[high] - prefix[low]).max(1e-10)) - 51.0
        });
        self.excitation.fill([0.0; FILTERS]);
        for (i, filter) in self.filters.iter().enumerate() {
            for (bin, &level) in levels.iter().enumerate() {
                let g = frequency(bin) * filter.inverse_frequency - 1.0;
                if g > 2.0 {
                    break;
                }
                let pg = if g < 0.0 {
                    -(filter.upper - filter.lower * level).max(0.1) * g
                } else {
                    filter.upper * g
                };
                let idx = ((pg / 0.02 + 0.5) as usize).min(1023);
                self.excitation[self.bands[bin]][i] += self.roex[idx] * self.weighted[bin];
            }
        }
        let total: [f64; FILTERS] =
            core::array::from_fn(|i| self.excitation.iter().map(|e| e[i]).sum());
        let mut instantaneous_sones = [0.0; 24];
        for (band, instant) in instantaneous_sones.iter_mut().enumerate() {
            for (i, &sum) in total.iter().enumerate() {
                self.specific[band][i] = self.filters[i].partial(self.excitation[band][i], sum);
                *instant += self.specific[band][i] * SPACING;
            }
            let coef = if *instant > self.short_term[band] {
                ATTACK
            } else {
                RELEASE
            };
            self.short_term[band] += coef * (*instant - self.short_term[band]);
        }
        PartialLoudnessFrame {
            sample_index,
            instantaneous_sones,
            short_term_sones: self.short_term,
        }
    }
}

pub struct PartialLoudnessMeter {
    pub spectrum: PartialSpectrum,
    ring: [f32; WINDOW],
    window: [f32; WINDOW],
    fft: [f32; WINDOW],
    cursor: usize,
    hop: usize,
    next_sample: u64,
    power_scale: f64,
}
impl PartialLoudnessMeter {
    pub fn new(calibration: Calibration) -> Self {
        let scale = f64::from(calibration.pascals_per_unit()) / 0.00002;
        Self {
            spectrum: PartialSpectrum::default(),
            ring: [0.0; WINDOW],
            fft: [0.0; WINDOW],
            window: core::array::from_fn(|i| {
                (0.5 - 0.5 * Float::cos(2.0 * core::f64::consts::PI * i as f64 / WINDOW as f64))
                    as f32
            }),
            cursor: 0,
            hop: 0,
            next_sample: 0,
            power_scale: 2.0 * scale * scale / (WINDOW * WINDOW) as f64 / 0.375,
        }
    }
    pub fn reset(&mut self, first_sample: u64) {
        self.ring.fill(0.0);
        self.cursor = 0;
        self.hop = 0;
        self.next_sample = first_sample;
        self.spectrum.short_term.fill(0.0);
    }
    pub fn push_pcm(
        &mut self,
        samples: &[f32],
        first_sample: u64,
        mut emit: impl FnMut(PartialLoudnessFrame),
    ) -> Result<(), LoudnessError> {
        if first_sample != self.next_sample {
            return Err(LoudnessError::Discontinuity {
                expected: self.next_sample,
                received: first_sample,
            });
        }
        if let Some(index) = samples.iter().position(|s| !s.is_finite()) {
            return Err(LoudnessError::NonFiniteSample { index });
        }
        for &sample in samples {
            self.ring[self.cursor] = sample;
            self.cursor = (self.cursor + 1) % WINDOW;
            self.hop += 1;
            self.next_sample += 1;
            if self.hop != HOP {
                continue;
            }
            self.hop = 0;
            for i in 0..WINDOW {
                self.fft[i] = self.ring[(self.cursor + i) % WINDOW] * self.window[i];
            }
            let bins = microfft::real::rfft_2048(&mut self.fft);
            let powers = core::array::from_fn(|i| {
                let c = bins[i + 1];
                (f64::from(c.re).powi(2) + f64::from(c.im).powi(2)) * self.power_scale
            });
            emit(self.spectrum.process(&powers, self.next_sample));
        }
        Ok(())
    }
}
