/// S = number of microphone samples
/// TODO: we need to have an option that uses a Box
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
pub struct Samples<const S: usize>(pub [f32; S]);

#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
pub struct WindowedSamples<const S: usize>(pub [f32; S]);

impl<const S: usize> WindowedSamples<S> {
    /// TODO: we need to do this in place
    pub fn from_samples(x: Samples<S>, multipliers: &[f32; S]) -> Self {
        // TODO: actually use the multipliers!
        let mut inner = x.0;

        for (x, multiplier) in inner.iter_mut().zip(multipliers.iter()) {
            *x *= multiplier;
        }

        Self(inner)
    }
}
