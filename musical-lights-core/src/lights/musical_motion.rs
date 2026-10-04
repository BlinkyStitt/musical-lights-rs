//! Hardware-neutral visual prototype calculations. SI inputs for drag, column
//! units for scrolling, linear RGB for pigments; no engine, heap, or browser APIs.
use num::Float;

/// Average absolute travel at 120 BPM: two columns per beat.
pub const SCROLL_SPEED: f64 = 4.0;
pub const SCROLL_EASE: f64 = 0.120;
pub const SCROLL_PEAK_SPEED: f64 = SCROLL_SPEED;

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
    use super::*;
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
