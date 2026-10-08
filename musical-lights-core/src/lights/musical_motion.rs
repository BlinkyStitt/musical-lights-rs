//! Hardware-neutral visual prototype calculations. SI inputs for drag, column
//! units for scrolling, linear RGB for pigments; no engine, heap, or browser APIs.
use num::Float;

/// Average absolute travel at 120 BPM: two columns per beat.
pub const SCROLL_SPEED: f64 = 4.0;
pub const SCROLL_EASE: f64 = 0.120;
pub const SCROLL_PEAK_SPEED: f64 = SCROLL_SPEED;

/// Two equal inward strokes share the room and leave the requested free space.
/// Hardware can use the same geometry with physical mirrors; no rendering APIs.
pub fn paired_bar_extent(height: f32, reserved: f32) -> f32 {
    if !height.is_finite() || !reserved.is_finite() {
        return 0.0;
    }
    (height.max(0.0) - reserved.max(0.0)).max(0.0) * 0.5
}

/// Allocation-free direction policy. Defaults: 5% at 60 BPM, 50% at 200 BPM.
/// The curve is an exponent: 1 is linear, >1 delays the increase, <1 advances it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DirectionOdds {
    values: [f64; 5],
}
impl Default for DirectionOdds {
    fn default() -> Self {
        Self {
            values: [60.0, 200.0, 0.05, 0.5, 1.0],
        }
    }
}
impl DirectionOdds {
    pub fn values(self) -> [f64; 5] {
        self.values
    }
    pub fn new(values: [f64; 5]) -> Result<Self, &'static str> {
        let [slow, fast, low, high, curve] = values;
        if !values.iter().all(|v| v.is_finite())
            || !(60.0..=200.0).contains(&slow)
            || !(60.0..=200.0).contains(&fast)
            || slow >= fast
            || !(0.0..=1.0).contains(&low)
            || !(low..=1.0).contains(&high)
            || !(0.25..=4.0).contains(&curve)
        {
            return Err("Invalid direction probability curve");
        }
        Ok(Self { values })
    }
    pub fn probability(self, bpm: f64) -> f64 {
        if !bpm.is_finite() {
            return 0.0;
        }
        let [slow, fast, low, high, curve] = self.values;
        let t = ((bpm.clamp(60.0, 200.0) - slow) / (fast - slow)).clamp(0.0, 1.0);
        low + (high - low) * Float::powf(t, curve)
    }
}

/// Silent display preview, independent of measured audio and attack envelopes.
/// A travelling sine covers every column; callers replace it when audio starts.
pub fn idle_wave(column: usize, columns: usize, seconds: f64, reduced: bool) -> f64 {
    if columns == 0 || !seconds.is_finite() {
        return 0.0;
    }
    let (period, amplitude) = if reduced { (12.0, 0.15) } else { (6.0, 0.3) };
    0.45 + amplitude
        * Float::sin(core::f64::consts::TAU * (column as f64 / columns as f64 - seconds / period))
}

/// Decorative microphone-listening floor, separate from measured loudness.
/// One sixth of bar travel at most; louder audio replaces it. No attack cues.
pub fn listening_level(level: f32, column: usize, seconds: f64, reduced: bool) -> f32 {
    if reduced || !seconds.is_finite() {
        return level;
    }
    let phase = core::f64::consts::TAU * (column as f64 / 24.0 - (seconds % 6.0) / 6.0);
    level.max(((1.0 + Float::sin(phase)) / 12.0) as f32)
}

/// Implicit quadratic sphere drag: Cd=0.47, rho=1.225 kg/m³. Multiplier always
/// stays in [0,1], including very fast velocities and large time steps.
pub fn sphere_drag_factor(radius: f32, speed: f32, mass: f32, dt: f32) -> f32 {
    if ![radius, speed, mass, dt].iter().all(|v| v.is_finite())
        || radius <= 0.0
        || mass <= 0.0
        || dt <= 0.0
    {
        return 1.0;
    }
    let coefficient = 0.5 * 1.225 * 0.47 * core::f32::consts::PI * radius * radius;
    1.0 / (1.0 + coefficient * speed.max(0.0) * dt / mass)
}

/// Retains three recent contact pigments. Call only on a new contact, so
/// persistent resting pressure cannot continuously recolor a ball or LED.
pub fn remember_pigment(history: &mut [f32; 9], pigment: [f32; 3]) {
    history.copy_within(0..6, 3);
    history[..3].copy_from_slice(&pigment);
}

#[cfg(test)]
mod tests {
    #[test]
    fn listening_floor_is_small_travelling_and_separate_from_louder_audio() {
        for band in 0..24 {
            let level = listening_level(0.0, band, 0.0, false);
            assert!((0.0..=1.0 / 6.0).contains(&level));
            assert_eq!(listening_level(0.7, band, 0.0, false), 0.7);
            assert_eq!(listening_level(0.0, band, 3.0, true), 0.0);
            assert!((level - listening_level(0.0, (band + 6) % 24, 1.5, false)).abs() < 1e-7);
        }
        assert_eq!(listening_level(0.5, 0, f64::NAN, false), 0.5);
    }
    use super::*;
    #[test]
    fn paired_strokes_leave_the_reserved_room() {
        let extent = paired_bar_extent(0.6, 0.24);
        assert!((extent * 2.0 + 0.24 - 0.6).abs() < 1e-6);
        assert_eq!(paired_bar_extent(0.1, 0.2), 0.0);
        assert_eq!(paired_bar_extent(f32::NAN, 0.0), 0.0);
    }
    #[test]
    fn direction_chance_scales_with_bounded_music_tempo() {
        for (bpm, expected) in [
            (0.0, 0.05),
            (60.0, 0.05),
            (130.0, 0.275),
            (200.0, 0.5),
            (999.0, 0.5),
        ] {
            assert!((DirectionOdds::default().probability(bpm) - expected).abs() < 1e-12);
        }
        assert_eq!(DirectionOdds::default().probability(f64::NAN), 0.0);
    }
    #[test]
    fn direction_curves_preserve_endpoints_and_reject_invalid_settings() {
        for exponent in [0.25, 1.0, 4.0] {
            let odds = DirectionOdds::new([80.0, 180.0, 0.1, 0.7, exponent]).unwrap();
            assert_eq!(odds.probability(60.0), 0.1);
            assert_eq!(odds.probability(200.0), 0.7);
            assert!(
                (odds.probability(130.0) - (0.1 + 0.6 * Float::powf(0.5, exponent))).abs() < 1e-12
            );
        }
        for settings in [
            [200.0, 60.0, 0.05, 0.5, 1.0],
            [60.0, 201.0, 0.05, 0.5, 1.0],
            [60.0, 200.0, 0.6, 0.5, 1.0],
            [60.0, 200.0, 0.05, 0.5, 0.0],
        ] {
            assert!(DirectionOdds::new(settings).is_err());
        }
    }
    #[test]
    fn idle_wave_covers_all_columns_and_travels_smoothly() {
        for column in 0..24 {
            let a = idle_wave(column, 24, 0.0, false);
            assert!((0.149..=0.751).contains(&a));
            assert!((a - idle_wave((column + 1) % 24, 24, 0.0, false)).abs() < 0.08);
            assert!((a - idle_wave(column, 24, 6.0, false)).abs() < 1e-12);
            assert!((0.299..=0.601).contains(&idle_wave(column, 24, 0.0, true)));
        }
        assert!((idle_wave(6, 24, 0.0, false) - 0.75).abs() < 1e-12);
        assert!((idle_wave(12, 24, 1.5, false) - 0.75).abs() < 1e-12);
        assert_eq!(idle_wave(0, 0, 0.0, false), 0.0);
    }
    #[test]
    fn drag_is_stable_and_depends_on_size_and_speed() {
        assert_eq!(sphere_drag_factor(0.1, 0.0, 1.0, 0.01), 1.0);
        let slow = sphere_drag_factor(0.1, 1.0, 1.0, 0.01);
        assert!(sphere_drag_factor(0.1, 10.0, 1.0, 0.01) < slow);
        assert!(sphere_drag_factor(0.2, 1.0, 1.0, 0.01) < slow);
        assert!((0.0..=1.0).contains(&sphere_drag_factor(0.1, 1e9, 1e-6, 1.0)));
    }
    #[test]
    fn remembers_contacts_in_order() {
        let mut history = [0.0; 9];
        remember_pigment(&mut history, [1.0, 0.0, 0.0]);
        remember_pigment(&mut history, [0.0, 1.0, 0.0]);
        assert_eq!(history, [0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    }
}
