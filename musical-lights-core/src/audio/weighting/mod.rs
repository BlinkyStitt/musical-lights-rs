mod a_weighting;
mod flat;

pub use a_weighting::AWeighting;
pub use flat::FlatWeighting;

/// similar to Windows, but different enough that I think we want a dedicated type
/// TODO: still really unsure about this. needing to move things around to the heap/boxes has confused me.
pub trait Weighting<const N: usize> {
    fn weight(&self, n: usize) -> f32;

    fn curve(&self) -> [f32; N] {
        let mut window = [0.0; N];

        self.curve_in_place(&mut window);

        window
    }

    fn curve_in_place(&self, output: &mut [f32; N]) {
        for (i, sample) in output.iter_mut().enumerate() {
            *sample = self.weight(i);
        }
    }
}
