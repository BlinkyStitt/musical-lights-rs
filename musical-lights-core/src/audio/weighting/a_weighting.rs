use crate::{
    audio::{bin_to_frequency, FFT},
    logging::debug,
    windows::Window,
};

use micromath::F32Ext;

impl<const IN: usize, const OUT: usize> FFT<IN, OUT> {
    /// TODO: use a trait just like we do for the window
    pub fn a_weighting<W: Window<IN>>(sample_rate_hz: f32) -> Self {
        let window_multipliers = W::windows();

        let window_scaling = W::scaling();

        let mut equal_loudness_curve = [1.0; OUT];
        for (i, x) in equal_loudness_curve.iter_mut().enumerate() {
            // TODO: bin_to_frequency is used twice. should we take it as an input instead of sample_rate_hz?
            let f = bin_to_frequency(i, sample_rate_hz, OUT);

            let b = a_weighting(f) * window_scaling;

            debug!("{} {} = {:?}", i, f, b);

            *x = b;
        }

        Self::new(window_multipliers, equal_loudness_curve)
    }
}

pub fn a_weighting_decibels(f: f32) -> f32 {
    let numerator = (12194f32.powi(2)) * f.powi(4);
    let denominator = (f.powi(2) + 20.6.powi(2))
        * ((f.powi(2) + 107.7.powi(2)) * (f.powi(2) + 737.9.powi(2))).sqrt()
        * (f.powi(2) + 12194f32.powi(2));

    let ra = numerator / denominator;

    20.0 * ra.log10() + 2.0
}

/// reminder, multiplying with this is the same as adding decibels
pub fn a_weighting(f: f32) -> f32 {
    let a_weighted_decibels = a_weighting_decibels(f);

    10.0f32.powf(a_weighted_decibels / 20.0)
}
