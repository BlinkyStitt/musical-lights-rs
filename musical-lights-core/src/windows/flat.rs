use super::Window;

pub struct FlatWindow<const N: usize>;

impl<const N: usize> Window<N> for FlatWindow<N> {
    fn input_window(_: usize) -> f32 {
        1.0
    }
}
