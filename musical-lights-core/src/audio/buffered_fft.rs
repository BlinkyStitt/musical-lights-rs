use core::marker::PhantomData;

#[cfg(feature = "std")]
use std::thread::yield_now;

use crate::{
    audio::{Samples, Weighting},
    windows::Window,
};
use circular_buffer::CircularBuffer;

/// put a circular buffer in front of an FFT. Use windowing to make the middle of the middle window more important.
/// TODO: think more about a-weighting
pub struct BufferedFFT<
    const SAMPLE_IN: usize,
    const FFT_IN: usize,
    const FFT_OUT: usize,
    WI: Window<FFT_IN>,
    WE: Weighting<FFT_OUT>,
> {
    /// TODO: need a test that adds to the circular buffer and makes sure it wraps around like we want
    sample_buf: CircularBuffer<FFT_IN, f32>,
    fft_buf: [f32; FFT_IN],
    window: PhantomData<WI>,
    weights: [f32; FFT_OUT],
    weighting: WE,
    // /// TODO: think more about this
    // fft_complex_output_buf: [Complex<f32>; FFT_OUT],
}

impl<
    const SAMPLE_IN: usize,
    const FFT_IN: usize,
    const FFT_OUT: usize,
    WI: Window<FFT_IN>,
    WE: Weighting<FFT_OUT>,
> BufferedFFT<SAMPLE_IN, FFT_IN, FFT_OUT, WI, WE>
{
    /// Use this when you want the buffered fft to be statically allocated.
    /// TODO: figure out how to call init on this from const. or at least how to make sure init gets called
    pub const fn uninit(weighting: WE) -> Self {
        assert!(SAMPLE_IN > 0);
        assert!(FFT_IN / 2 == FFT_OUT);
        assert!(FFT_IN % SAMPLE_IN == 0);

        Self {
            sample_buf: CircularBuffer::new(),
            fft_buf: [0.0; FFT_IN],
            window: PhantomData::<WI>,
            weights: [0.0; FFT_OUT],
            weighting,
        }
    }

    /// useful if you don't need this statically allocated.
    pub fn new(weighting: WE) -> Self {
        let mut x = Self::uninit(weighting);

        x.init();

        x
    }

    /// TODO: use types to make sure this function is called after uninit!
    pub fn init(&mut self) {
        self.sample_buf.fill(0.0);

        let window_scaling = WI::scaling();

        for (i, x) in self.weights.iter_mut().enumerate() {
            *x = window_scaling * self.weighting.weight(i) / FFT_OUT as f32;
        }
    }

    pub fn push_samples(&mut self, samples: &Samples<SAMPLE_IN>) {
        self.sample_buf.extend_from_slice(&samples.0)
    }
}

/// TODO: macro for this so we can support multiple rfft sizes. or maybe a different library that does more at runtime?
impl<const SAMPLE_IN: usize, WI: Window<4096>, WE: Weighting<2048>>
    BufferedFFT<SAMPLE_IN, 4096, 2048, WI, WE>
{
    /// TODO: not sure what type to put here for the output? WeightedOutputs?
    /// TODO: what should this function be called?
    pub fn fft(&mut self, output: &mut [f32; 2048]) {
        // first, we load buffer up with the samples (TODO: move this to a helper function?)
        let (a, b) = self.sample_buf.as_slices();
        self.fft_buf[..a.len()].copy_from_slice(a);
        self.fft_buf[a.len()..].copy_from_slice(b);

        WI::apply_windows(&mut self.fft_buf);

        // TODO: yield here with a specific compile time feature
        #[cfg(feature = "std")]
        yield_now();

        let spectrum = microfft::real::rfft_4096(&mut self.fft_buf);

        // TODO: yield here with a specific compile time feature
        #[cfg(feature = "std")]
        yield_now();

        // since the real-valued coefficient at the Nyquist frequency is packed into the
        // imaginary part of the DC bin, it must be cleared before computing the amplitudes
        // TODO: what does this even mean?
        // TODO: print this once per second. need an every_n_milliseconds macro like fastled has
        // info!("???: {}", spectrum[0].im);
        spectrum[0].im = 0.0;

        // TODO: can we do this better?
        // TODO: i think we should just skip the first bin entirely
        for ((a, &s), w) in output
            .iter_mut()
            .zip(spectrum.iter())
            .zip(self.weights.iter())
        {
            // calculate the magnitude of the sample, then apply the window scaling and weighting
            // TODO: i think theres more to do here. we want to sum the power (a * a)
            *a = s.norm() * w;
        }

        // // TODO: yield here with a specific compile time feature
        // #[cfg(feature = "std")]
        // yield_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extend_from_slice() {
        let mut buf: CircularBuffer<5, u32> = CircularBuffer::from([1, 2, 3]);
        buf.extend_from_slice(&[4, 5, 6, 7]);
        assert_eq!(buf, [3, 4, 5, 6, 7]);
    }

    #[test]
    fn test_sin_waves() {
        todo!(
            "set up a small buffered fft with a known frequency and then make sure we get expected values out of it"
        );
    }
}
