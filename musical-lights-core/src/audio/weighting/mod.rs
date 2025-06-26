mod a_weighting;
mod flat;

pub use a_weighting::AWeighting;
pub use flat::FlatWeighting;
use itertools::Itertools;

/// similar to Windows, but different enough that I think we want a dedicated type
/// TODO: still really unsure about this. needing to move things around to the heap/boxes has confused me.
pub trait Weighting<const N: usize> {
    /// the linear weight (NOT in db!).
    fn weight(&self, n: usize) -> f32;

    /// bin 0 is special. we want to leave it alone
    /// TODO: think more about this
    fn weight_skip_0(&self, n: usize) -> f32 {
        if n == 0 { 1.0 } else { self.weight(n) }
    }

    #[inline]
    fn curve(&self) -> [f32; N] {
        let mut window = [0.0; N];

        self.curve_in_place(&mut window);

        window
    }

    /// TODO: whats the rusty name for this?
    /// TODO: what if we want the decibels adjustment instead of the
    #[inline]
    fn curve_in_place(&self, output: &mut [f32; N]) {
        output.iter_mut().set_from(self.curve_iter());
    }

    /// Iterators are cool.
    #[inline]
    fn curve_iter(&self) -> impl Iterator<Item = f32> {
        (0..N).map(|x| self.weight(x))
    }
}
