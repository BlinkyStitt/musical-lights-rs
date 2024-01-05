use core::f32::consts::PI;

pub fn hanning_window(i: usize, n: usize) -> f32 {
    0.5 - 0.5 * (2.0 * PI * i as f32 / n as f32).cos()
}
