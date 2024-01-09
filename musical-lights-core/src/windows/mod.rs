mod hanning;

pub use hanning::HanningWindow;

pub trait Window<const N: usize> {
    fn window(i: usize) -> f32;

    fn windows() -> [f32; N] {
        let mut window = [0.0; N];

        for (i, sample) in window.iter_mut().enumerate() {
            *sample = Self::window(i);
        }

        window
    }
}
