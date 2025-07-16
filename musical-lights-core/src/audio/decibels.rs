#[cfg(not(any(feature = "std", feature = "libm")))]
use micromath::F32Ext;

use super::amplitudes::{AggregatedBins, Amplitudes};

#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct Decibels<const N: usize>(pub [f32; N]);

impl<const B: usize> Decibels<B> {
    pub fn from_floats(mut x: [f32; B]) -> Self {
        for i in x.iter_mut() {
            // TODO: is abs needed? aren't these always positive already?
            debug_assert!(*i >= 0.0);

            *i = 20.0 * i.log10();
        }

        Self(x)
    }

    pub fn from_amplitudes(x: Amplitudes<B>) -> Self {
        Self::from_floats(x.0)
    }

    pub fn from_aggregated_amplitudes(x: AggregatedBins<B>) -> Self {
        Self::from_floats(x.0)
    }
}
