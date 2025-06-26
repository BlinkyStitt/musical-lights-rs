mod flat;
mod hanning;

use crate::logging::info;
use itertools::Itertools;

pub use flat::FlatWindow;
pub use hanning::HanningWindow;

/// TODO: really not sure about this anymore
pub trait Window<const N: usize> {
    /// since the windows have some part of them reduced from their original value, we need to get them back to 1.0 after doing an FFT.
    /// TODO: think more about this
    fn output_scaling() -> f32 {
        let sum_windows: f32 = Self::input_windows_iter().sum::<f32>();

        // let coherent_gain = sum_windows / N as f32;
        // 1.0 / coherent_gain

        let scaling = N as f32 / sum_windows;

        info!("scaling: {}", scaling);

        scaling
    }

    fn input_window(i: usize) -> f32;

    /// TODO: cache this?
    fn input_windows() -> [f32; N] {
        let mut window = [0.0; N];

        for (i, sample) in window.iter_mut().enumerate() {
            *sample = Self::input_window(i);

            info!("{} = {}", i, sample);
        }

        window
    }

    #[inline]
    fn input_windows_iter() -> impl Iterator<Item = f32> {
        (0..N).map(|i| Self::input_window(i))
    }

    /// TODO: is this a good name?
    /// TODO: do we even use this? we usually save the window weights in an array and zip that up
    #[inline]
    fn apply_windows(x: &mut [f32; N]) {
        for (sample, multiplier) in x.iter_mut().zip(Self::input_windows_iter()) {
            *sample *= multiplier;
        }
    }
}
