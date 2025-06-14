use crate::audio::bin_to_frequency;

use micromath::F32Ext;

use super::Weighting;

/// TODO: i'm not sure we need this. i think the microphone already does this for us!
pub struct AWeighting<const N: usize> {
    sample_rate_hz: f32,
}

impl<const N: usize> AWeighting<N> {
    pub fn new(sample_rate_hz: f32) -> Self {
        Self { sample_rate_hz }
    }
}

impl<const N: usize> Weighting<N> for AWeighting<N> {
    fn weight(&self, i: usize) -> f32 {
        let f = bin_to_frequency(i, self.sample_rate_hz, N);

        a_weighting(f)
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
