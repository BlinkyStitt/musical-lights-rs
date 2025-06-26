// TODO: why does the linter think this is unused when math functions on f32 are used. something about std being enabled in the linter?
// TODO: use libm instead?
#[allow(unused_imports)]
use micromath::F32Ext;

use super::Window;

pub struct FlatWindow<const N: usize>;

impl<const N: usize> Window<N> for FlatWindow<N> {
    fn input_window(_: usize) -> f32 {
        1.0
    }
}
