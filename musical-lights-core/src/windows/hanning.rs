use core::f32::consts::PI;

// TODO: why does the linter think this is unused when math functions on f32 are used. something about std being enabled in the linter?
// TODO: use libm instead?
#[allow(unused_imports)]
use micromath::F32Ext;

use super::Window;

pub struct HanningWindow<const N: usize>;

impl<const N: usize> Window<N> for HanningWindow<N> {
    fn input_window(i: usize) -> f32 {
        0.5 - 0.5 * (2.0 * PI * i as f32 / N as f32).cos()
    }
}
