use crate::audio::bin_to_frequency;

#[allow(unused_imports)]
use micromath::F32Ext;

use super::Weighting;

pub struct AWeighting<const N: usize> {
    sample_rate_hz: f32,
}

impl<const N: usize> AWeighting<N> {
    /// TODO: create a lookup table, or calculate as needed? a lookup table is easy to add after this
    pub const fn new(sample_rate_hz: f32) -> Self {
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
    let denominator = (f.powi(2) + 20.6f32.powi(2))
        * ((f.powi(2) + 107.7f32.powi(2)) * (f.powi(2) + 737.9f32.powi(2))).sqrt()
        * (f.powi(2) + 12194f32.powi(2));

    let ra = numerator / denominator;

    20.0 * ra.log10() + 2.0
}

/// reminder, multiplying with this is the same as adding decibels
pub fn a_weighting(f: f32) -> f32 {
    let a_weighted_decibels = a_weighting_decibels(f);

    10.0f32.powf(a_weighted_decibels / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_a_weighting() {
        assert_eq!(a_weighting(0.0), 0.0);
    }
}
