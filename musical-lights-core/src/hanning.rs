use core::f32::consts::PI;

// TODO: why does the linter think this is unused when math functions on f32 are used. something about std being enabled in the linter?
#[allow(unused_imports)]
use micromath::F32Ext;

pub fn hanning_window(i: usize, n: usize) -> f32 {
    0.5 - 0.5 * (2.0 * PI * i as f32 / n as f32).cos()
}
