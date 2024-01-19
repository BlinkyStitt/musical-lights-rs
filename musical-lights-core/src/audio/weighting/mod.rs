mod a_weighting;
mod flat;

pub use a_weighting::AWeighting;
pub use flat::FlatWeighting;

/// similar to Windows, but different enough that I think we want a dedicated type
pub trait Weighting<const N: usize> {
    fn weight(&self, n: usize) -> f32;

    fn curve(&self) -> [f32; N] {
        let mut window = [0.0; N];

        for (i, sample) in window.iter_mut().enumerate() {
            *sample = self.weight(i);
        }

        window
    }
}
