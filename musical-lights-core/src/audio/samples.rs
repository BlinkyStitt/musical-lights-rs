/// S = number of microphone samples
/// TODO: we need to have an option that uses a Box
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct Samples<const S: usize>(pub [f32; S]);
