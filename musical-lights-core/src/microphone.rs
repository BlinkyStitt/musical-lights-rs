/// S = number of microphone samples
pub struct MicrophoneSamples<const S: usize>(pub [f32; S]);

/// B = number of frequency bins
pub struct RawFFT<const B: usize>(pub [f32; B]);

/// N = number of frequency bins
pub struct HumanHearingBalancedFFT<const N: usize>(pub [f32; N]);

impl<const S: usize, const N: usize> From<MicrophoneSamples<S>> for RawFFT<N> {
    fn from(x: MicrophoneSamples<S>) -> Self {
        todo!()
    }
}

/// N can be <= B
impl<const B: usize, const N: usize> From<RawFFT<B>> for HumanHearingBalancedFFT<N> {
    fn from(x: RawFFT<B>) -> Self {
        todo!()
    }
}
