//! Hardware-neutral, allocation-free musical direction and flight policy.
//! Loudness is unscaled sones; times are seconds, travel is in columns.
use super::musical_motion::{DirectionOdds, SCROLL_EASE, SCROLL_SPEED};
use num::Float;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectionChoice {
    Unchanged,
    Horizontal,
}

/// One decision per acoustic crest, including attacks spread across bands.
#[derive(Default)]
pub struct RecentPeak {
    peak: f64,
    previous_at: Option<f64>,
    deadline: Option<f64>,
    eligible: bool,
}
impl RecentPeak {
    pub fn push(&mut self, at: f64, loudness: f64, attack: bool) -> bool {
        if !at.is_finite() || !loudness.is_finite() || loudness < 0.0 {
            return false;
        }
        if self.previous_at.is_some_and(|last| at < last) {
            return false;
        }
        let dt = self.previous_at.map_or(0.0, |last| at - last);
        self.previous_at = Some(at);
        self.peak *= Float::exp(-dt / 8.0);
        let emitted = self.deadline.is_some_and(|end| at >= end) && self.eligible;
        if self.deadline.is_some_and(|end| at >= end) {
            self.deadline = None;
            self.eligible = false;
        }
        if attack {
            self.deadline.get_or_insert(at + 0.060);
            self.eligible |= loudness > self.peak && loudness >= 0.1;
        }
        self.peak = self.peak.max(loudness);
        emitted
    }
}

/// Idle crests are synthetic and use independent peak history.
#[derive(Default)]
pub struct IdlePeak {
    peak: RecentPeak,
    cycle: Option<u64>,
    previous_at: Option<f64>,
    moving_seconds: f64,
}
impl IdlePeak {
    pub fn push(&mut self, seconds: f64, reduced: bool) -> bool {
        if !seconds.is_finite() || seconds < 0.0 {
            return false;
        }
        if self.previous_at.is_some_and(|last| seconds < last) {
            return false;
        }
        let dt = self.previous_at.map_or(0.0, |last| seconds - last);
        self.previous_at = Some(seconds);
        if !reduced {
            self.moving_seconds += dt;
        }
        let cycle = Float::floor(self.moving_seconds / 6.0) as u64;
        let completed = self.cycle.is_some_and(|old| cycle > old);
        self.cycle = Some(cycle);
        self.peak
            .push(self.moving_seconds, 0.75, completed && !reduced)
    }
}

/// A seed and an event ordinal suffice to reproduce every probability draw.
pub struct DanceMotion {
    random: u32,
    pub direction: f64,
    pub tempo: f64,
    pub odds: DirectionOdds,
    speed: f64,
    enabled: bool,
    stop_from: f64,
    stop_elapsed: f64,
}
impl DanceMotion {
    pub fn new(seed: u32) -> Self {
        Self {
            random: seed.max(1),
            direction: 1.0,
            tempo: 120.0,
            odds: DirectionOdds::default(),
            speed: 0.0,
            enabled: false,
            stop_from: 0.0,
            stop_elapsed: SCROLL_EASE,
        }
    }
    pub fn choose(&mut self) -> DirectionChoice {
        self.random ^= self.random << 13;
        self.random ^= self.random >> 17;
        self.random ^= self.random << 5;
        self.choose_draw(f64::from(self.random) / (f64::from(u32::MAX) + 1.0))
    }
    /// Exposed for embedded callers with their own source of randomness.
    pub fn choose_draw(&mut self, draw: f64) -> DirectionChoice {
        if !draw.is_finite()
            || !(0.0..1.0).contains(&draw)
            || draw >= self.odds.probability(self.tempo)
        {
            DirectionChoice::Unchanged
        } else {
            self.direction = -self.direction;
            DirectionChoice::Horizontal
        }
    }
    pub fn advance(&mut self, enabled: bool, bpm: f64, dt: f64) -> f64 {
        if !dt.is_finite() || dt <= 0.0 || !bpm.is_finite() {
            return 0.0;
        }
        self.tempo = bpm.clamp(60.0, 200.0);
        if !enabled {
            if self.enabled {
                self.stop_from = self.speed;
                self.stop_elapsed = 0.0;
            }
            self.enabled = false;
            let before = self.stop_elapsed;
            self.stop_elapsed = (before + dt).min(SCROLL_EASE);
            let a = before / SCROLL_EASE;
            let b = self.stop_elapsed / SCROLL_EASE;
            self.speed = self.stop_from * (1.0 - 3.0 * b * b + 2.0 * b * b * b);
            let integral = |x: f64| x - x * x * x + 0.5 * x * x * x * x;
            return self.stop_from * SCROLL_EASE * (integral(b) - integral(a));
        }
        self.enabled = true;
        let target = self.direction * SCROLL_SPEED * bpm.clamp(60.0, 200.0) / 120.0;
        let before = self.speed;
        let decay = Float::exp(-dt / SCROLL_EASE);
        self.speed = target + (before - target) * decay;
        target * dt + (before - target) * SCROLL_EASE * (1.0 - decay)
    }
    pub fn speed(&self) -> f64 {
        self.speed
    }
}

pub fn flight_height(available: f32, fraction: f32, reduced: bool) -> f32 {
    if !available.is_finite() || !fraction.is_finite() {
        return 0.0;
    }
    let height = available.max(0.0) * fraction.clamp(0.0, 0.5);
    if reduced {
        (height * 0.5).min(0.025)
    } else {
        height
    }
}

pub fn release_speed(gravity: f32, height: f32) -> f32 {
    Float::sqrt(2.0 * gravity.max(0.0) * height.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_draw_uses_the_tempo_scaled_horizontal_probability() {
        let mut motion = DanceMotion::new(1);
        motion.tempo = 60.0;
        assert_eq!(motion.choose_draw(0.04999), DirectionChoice::Horizontal);
        assert_eq!(motion.choose_draw(0.05), DirectionChoice::Unchanged);
        motion.tempo = 200.0;
        assert_eq!(motion.choose_draw(0.49999), DirectionChoice::Horizontal);
        assert_eq!(motion.choose_draw(0.5), DirectionChoice::Unchanged);
        assert_eq!(motion.choose_draw(f64::NAN), DirectionChoice::Unchanged);
    }
    #[test]
    fn seeded_decisions_reproduce_and_travel_never_reverses_without_an_event() {
        let (mut a, mut b) = (DanceMotion::new(123), DanceMotion::new(123));
        for _ in 0..1000 {
            assert_eq!(a.choose(), b.choose());
        }
        let mut a = DanceMotion::new(123);
        let mut travel = 0.0;
        for _ in 0..1200 {
            let dx = a.advance(true, 120.0, 1.0 / 120.0);
            assert!(dx >= 0.0);
            travel += dx;
        }
        assert!((travel - 39.52).abs() < 1e-5);
        let before = a.speed();
        a.choose_draw(0.0);
        assert!(a.advance(true, 120.0, 1.0 / 120.0).abs() < before / 120.0);
    }
    #[test]
    fn attacks_need_a_new_peak_and_multiband_attacks_are_grouped() {
        let mut peak = RecentPeak::default();
        assert!(!peak.push(0.0, 2.0, false));
        assert!(!peak.push(0.01, 1.0, true));
        assert!(!peak.push(0.08, 1.0, false));
        assert!(!peak.push(0.1, 3.0, true));
        assert!(!peak.push(0.12, 4.0, true));
        assert!(peak.push(0.17, 4.0, false));
        assert!(!peak.push(0.18, 4.0, false));
        assert!(!peak.push(0.2, 5.0, false));
        assert!(!peak.push(0.3, 4.0, true));
        assert!(!peak.push(0.37, 4.0, false));
    }
    #[test]
    fn flight_budget_is_bounded_and_reduced_motion_is_gentler() {
        assert!((flight_height(0.4, 0.3, false) - 0.12).abs() < 1e-6);
        assert_eq!(flight_height(0.4, 0.3, true), 0.025);
        assert_eq!(flight_height(-1.0, 0.3, false), 0.0);
        assert!((release_speed(9.81, 0.12) - 1.5344).abs() < 0.001);
    }

    #[test]
    fn idle_decisions_require_a_completed_cycle_and_never_run_under_reduced_motion() {
        let mut idle = IdlePeak::default();
        assert!(!idle.push(0.0, false));
        assert!(!idle.push(5.9, false));
        assert!(!idle.push(6.0, false));
        assert!(idle.push(6.07, false));
        assert!(!idle.push(6.08, false));
        assert!(!idle.push(11.9, false));
        assert!(!idle.push(12.0, false));
        assert!(idle.push(12.07, false));
        assert!(!idle.push(6.0, false));
        assert!(!idle.push(12.1, false));
        let mut reduced = IdlePeak::default();
        for i in 0..3000 {
            assert!(!reduced.push(f64::from(i) / 50.0, true));
        }
    }

    #[test]
    fn reduced_motion_pauses_the_idle_cycle_clock_without_a_resume_draw() {
        let mut idle = IdlePeak::default();
        for (at, reduced) in [
            (0.0, false),
            (1.0, false),
            (6.0, true),
            (6.01, false),
            (6.08, false),
            (10.9, false),
            (11.0, false),
            (11.02, false),
        ] {
            assert!(!idle.push(at, reduced), "at={at}, reduced={reduced}");
        }
        assert!(idle.push(11.10, false));
        assert!(!idle.push(11.11, false));
    }
}
