use core::f32::consts::PI;

#[allow(unused_imports)]
use micromath::F32Ext;

use super::Window;

pub struct HanningWindow<const N: usize>;

impl<const N: usize> Window<N> for HanningWindow<N> {
    fn input_window(i: usize) -> f32 {
        0.5 - 0.5 * (2.0 * PI * i as f32 / N as f32).cos()
    }
}
