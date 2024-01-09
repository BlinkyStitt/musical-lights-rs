mod hanning;

use crate::logging::debug;
pub use hanning::HanningWindow;

pub trait Window<const N: usize> {
    /// since the windows have some part of them reduced from their original value, we need to offset them back after doing an FFT to get them back to 1.0
    fn scaling() -> f32 {
        let sum: f32 = (0..N)
            .map(|i| {
                let x = Self::window(i);

                debug!("{} = {}", i, x);

                x
            })
            .sum();

        // let coherent_gain = sum / N as f32;
        // 1.0 / coherent_gain

        let scaling = N as f32 / sum;

        debug!("scaling: {}", scaling);

        scaling
    }

    fn window(i: usize) -> f32;

    fn windows() -> [f32; N] {
        let mut window = [0.0; N];

        for (i, sample) in window.iter_mut().enumerate() {
            *sample = Self::window(i);
        }

        window
    }
}
