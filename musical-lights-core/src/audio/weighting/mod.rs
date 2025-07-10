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
    /// the last bin is also apparently special.
    /// we also double it because the fft outputs are only half the wave. i think thats correct.
    /// TODO: think more about this. read more
    /// TODO: this can't be const because we are in a trait. noooo
    fn weight_skip_ends(&self, n: usize) -> f32 {
        if n == 0 || n == N - 1 {
            1.0
        } else {
            self.weight(n) * 2.0
        }
    }

    #[inline]
    fn curve(&self) -> [f32; N] {
        let mut window = [0.0; N];

        self.curve_buf(&mut window);

        window
    }

    /// TODO: whats the rusty name for this?
    /// TODO: what if we want the decibels adjustment instead of the
    #[inline]
    fn curve_buf(&self, output: &mut [f32; N]) {
        output.iter_mut().set_from(self.curve_iter());
    }

    /// Iterators are cool. They aren't const, but traits aren't either so I guess its fine.
    #[inline]
    fn curve_iter(&self) -> impl Iterator<Item = f32> {
        (0..N).map(|x| self.weight_skip_ends(x))
    }
}
