//! Browser presentation, never a loudness measurement.
//!
//! One Euro motion filtering (Casiez, Roussel, Vogel, CHI 2012), extended
//! with one shared coefficient to preserve proportional input histories.
//! SuperFlux novelty (Böck, Widmer, DAFx 2013), adapted to causal 2 ms frames
//! and source-band attribution. Thresholds and flashes are presentation choices.
use super::{
    partial::{BINS, HOP, WINDOW},
    visual::{BARK_EDGES, BandLevel, DISPLAY_BANDS, DisplayFrame},
};
use num::Float;

const DT: f64 = HOP as f64 / 48000.0;
const FILTER_CAPACITY: usize = 256;
const HISTORY: usize = 50;

fn alpha(cutoff: f64) -> f64 {
    1.0 / (1.0 + 1.0 / (2.0 * core::f64::consts::PI * cutoff * DT))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BrowserSnapshot {
    at: f64,
    reduced: bool,
    pub targets: [f32; DISPLAY_BANDS],
    pub filtered: [f32; DISPLAY_BANDS],
    pub attacks: [Option<f64>; DISPLAY_BANDS],
    pub sones: [f32; DISPLAY_BANDS],
}
impl BrowserSnapshot {
    pub const VERSION: f64 = 4.0;
    pub const TRANSPORT_LEN: usize = 3 + DISPLAY_BANDS * 4;
    pub fn new(at: f64) -> Self {
        Self {
            at,
            reduced: false,
            targets: [0.0; DISPLAY_BANDS],
            filtered: [0.0; DISPLAY_BANDS],
            attacks: [None; DISPLAY_BANDS],
            sones: [0.0; DISPLAY_BANDS],
        }
    }
    pub fn timestamp(&self) -> f64 {
        self.at
    }
    pub fn frame(&self, at: f64) -> DisplayFrame<DISPLAY_BANDS> {
        DisplayFrame {
            levels: self.filtered,
            edges: self.attacks.map(|attack| {
                attack.map_or(0.0, |start| {
                    let age = (at - start).max(0.0);
                    if age >= 0.100 {
                        0.0
                    } else {
                        ((1.0 - age / 0.100).powi(2) * if self.reduced { 0.5 } else { 1.0 }) as f32
                    }
                })
            }),
        }
    }
    pub fn write_transport(&self, out: &mut [f64]) {
        assert_eq!(out.len(), Self::TRANSPORT_LEN);
        out[..3].copy_from_slice(&[self.at, f64::from(self.reduced), Self::VERSION]);
        for i in 0..DISPLAY_BANDS {
            out[3 + i * 4..7 + i * 4].copy_from_slice(&[
                self.targets[i] as f64,
                self.filtered[i] as f64,
                self.attacks[i].unwrap_or(-1.0),
                self.sones[i] as f64,
            ]);
        }
    }
    pub fn from_transport(input: &[f64]) -> Option<Self> {
        if input.len() != Self::TRANSPORT_LEN
            || input[2] != Self::VERSION
            || !input.iter().all(|x| x.is_finite())
            || input[0] < 0.0
            || ![0.0, 1.0].contains(&input[1])
        {
            return None;
        }
        let mut state = Self::new(input[0]);
        state.reduced = input[1] == 1.0;
        for i in 0..DISPLAY_BANDS {
            let row = &input[3 + i * 4..7 + i * 4];
            if !(0.0..=1.0).contains(&row[0])
                || !(0.0..=1.0).contains(&row[1])
                || !(row[2] == -1.0 || (0.0..=state.at).contains(&row[2]))
                || !(0.0..=f32::MAX as f64).contains(&row[3])
            {
                return None;
            }
            state.targets[i] = row[0] as f32;
            state.filtered[i] = row[1] as f32;
            state.attacks[i] = (row[2] >= 0.0).then_some(row[2]);
            state.sones[i] = row[3] as f32;
        }
        Some(state)
    }
}

#[derive(Clone, Copy, Default)]
struct Triangle {
    start: usize,
    mid: usize,
    end: usize,
    band: usize,
}

/// Fixed storage; no allocation, extra FFT, or lookahead in the worklet.
pub struct BrowserPresentation {
    pub snapshot: BrowserSnapshot,
    derivative: [f64; DISPLAY_BANDS],
    filtered: [f64; DISPLAY_BANDS],
    filters: [Triangle; FILTER_CAPACITY],
    filter_count: usize,
    spectra: [[f64; FILTER_CAPACITY]; 6],
    history: [[f64; DISPLAY_BANDS]; HISTORY],
    frames: usize,
    started_at: f64,
    armed: [bool; DISPLAY_BANDS],
    quiet: [usize; DISPLAY_BANDS],
    candidate: [Option<(f64, f32)>; DISPLAY_BANDS],
    pub novelty: [f64; DISPLAY_BANDS],
    pub magnitude: [f64; DISPLAY_BANDS],
}
impl BrowserPresentation {
    pub fn new(at: f64) -> Self {
        // Quarter-tone centers, A4=440 Hz, rounded to unique FFT bins as in
        // the reference. Include one outer knot on each side of 27.5..16000 Hz.
        let ratio = Float::powf(2.0_f64, 1.0 / 24.0);
        let mut knots = [0; FILTER_CAPACITY];
        let mut count = 0;
        let mut frequency = 27.5 / ratio;
        loop {
            let bin = Float::round(frequency * WINDOW as f64 / 48000.0) as usize;
            if count == 0 || knots[count - 1] != bin {
                knots[count] = bin;
                count += 1;
            }
            if frequency > 16000.0 {
                break;
            }
            frequency *= ratio;
        }
        let mut filters = [Triangle::default(); FILTER_CAPACITY];
        for i in 0..count - 2 {
            let center = knots[i + 1] as f64 * 48000.0 / WINDOW as f64;
            filters[i] = Triangle {
                start: knots[i],
                mid: knots[i + 1],
                end: knots[i + 2],
                band: BARK_EDGES[1..]
                    .iter()
                    .position(|&f| center < f as f64)
                    .unwrap_or(DISPLAY_BANDS),
            };
        }
        Self {
            snapshot: BrowserSnapshot::new(at),
            derivative: [0.0; DISPLAY_BANDS],
            filtered: [0.0; DISPLAY_BANDS],
            filters,
            filter_count: count - 2,
            spectra: [[0.0; FILTER_CAPACITY]; 6],
            history: [[0.0; DISPLAY_BANDS]; HISTORY],
            frames: 0,
            started_at: at,
            armed: [true; DISPLAY_BANDS],
            quiet: [0; DISPLAY_BANDS],
            candidate: [None; DISPLAY_BANDS],
            novelty: [0.0; DISPLAY_BANDS],
            magnitude: [0.0; DISPLAY_BANDS],
        }
    }
    pub fn push(
        &mut self,
        at: f64,
        levels: [BandLevel; DISPLAY_BANDS],
        spectrum: &[f64; BINS],
        reduced: bool,
    ) {
        let previous_sones = self.snapshot.sones;
        self.smooth(levels);
        self.snapshot.at = at;
        self.snapshot.reduced = reduced;
        let slot = self.frames % 6;
        let old = (self.frames + 1) % 6; // five 2 ms hops ago
        self.novelty.fill(0.0);
        self.magnitude.fill(0.0);
        for j in 0..self.filter_count {
            let f = self.filters[j];
            let mut sum = 0.0;
            for bin in f.start..f.end {
                let weight = if bin < f.mid {
                    (bin - f.start) as f64 / (f.mid - f.start) as f64
                } else {
                    (f.end - bin) as f64 / (f.end - f.mid) as f64
                };
                if bin > 0 && bin <= BINS {
                    sum += spectrum[bin - 1] * weight;
                }
            }
            let value = Float::log10(1.0 + sum);
            self.spectra[slot][j] = value;
            if f.band < DISPLAY_BANDS {
                let previous = self.spectra[old]
                    [j.saturating_sub(1)..(j + 2).min(self.filter_count)]
                    .iter()
                    .copied()
                    .fold(0.0_f64, f64::max);
                self.novelty[f.band] += (value - previous).max(0.0);
                self.magnitude[f.band] += value;
            }
        }
        for (i, level) in levels.iter().enumerate() {
            let mean = self.history.iter().map(|h| h[i]).sum::<f64>() / HISTORY as f64;
            let peak = (1..=15)
                .map(|age| self.history[(self.frames + HISTORY - age) % HISTORY][i])
                .fold(0.0_f64, f64::max);
            let flux = self.novelty[i];
            if flux <= mean + 0.05 {
                self.quiet[i] += 1;
            } else {
                self.quiet[i] = 0;
            }
            if self.quiet[i] >= 30 {
                self.armed[i] = true;
            }
            let interval = self.snapshot.attacks[i].is_none_or(|last| at - last >= 0.160 - 1e-9);
            if self.candidate[i].is_some_and(|(deadline, _)| at > deadline) {
                self.candidate[i] = None;
            }
            if at - self.started_at >= 0.250
                && self.armed[i]
                && interval
                && flux >= peak
                && flux > mean + 0.1
                && flux >= 0.15 * self.magnitude[i]
                && self.candidate[i].is_none()
            {
                // Spectral novelty precedes short-term loudness. Keep a bounded
                // candidate while that same attack reaches the loudness gate.
                self.candidate[i] = Some((at + 0.030, previous_sones[i]));
            }
            // A stopped tone can create spectral leakage novelty. It is not a
            // new loud attack when that band's measured loudness is falling.
            if self.candidate[i].is_some_and(|(_, baseline)| level.sones > baseline)
                && self.armed[i]
                && interval
                && level.sones >= 0.1
                && level.activity >= 0.35
            {
                self.snapshot.attacks[i] = Some(at);
                self.armed[i] = false;
                self.candidate[i] = None;
            }
        }
        self.history[self.frames % HISTORY] = self.novelty;
        self.frames += 1;
    }
    fn smooth(&mut self, levels: [BandLevel; DISPLAY_BANDS]) {
        let mut speed = 0.0_f64;
        for (i, level) in levels.iter().enumerate() {
            let derivative = (f64::from(level.activity) - self.filtered[i]) / DT;
            self.derivative[i] += alpha(1.0) * (derivative - self.derivative[i]);
            speed = speed.max(self.derivative[i].abs());
        }
        let coefficient = alpha(1.0 + 0.8 * speed);
        for (i, level) in levels.iter().enumerate() {
            self.filtered[i] += coefficient * (f64::from(level.activity) - self.filtered[i]);
            self.snapshot.targets[i] = level.activity;
            self.snapshot.filtered[i] = self.filtered[i] as f32;
            self.snapshot.sones[i] = level.sones;
        }
    }
}

#[cfg(test)]
mod tests;
