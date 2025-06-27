use core::marker::PhantomData;

#[cfg(feature = "std")]
use std::thread::yield_now;

use crate::{audio::Samples, logging::debug, windows::Window};
use circular_buffer::CircularBuffer;
use num::Complex;

/// put a circular buffer in front of an FFT. Use windowing to make the middle of the middle window more important.
pub struct BufferedFFT<
    const SAMPLE_IN: usize,
    const FFT_IN: usize,
    const FFT_OUT: usize,
    WI: Window<FFT_IN>,
> {
    /// TODO: need a test that adds to the circular buffer and makes sure it wraps around like we want
    sample_buf: CircularBuffer<FFT_IN, f32>,
    /// TODO: this should be the existing FFT object so we can reuse that code. it wasn't built with buffers in mind most of the time though. not a terrible refactor
    fft_buf: [f32; FFT_IN],
    input_window: PhantomData<WI>,
    window_scale_inputs: [f32; FFT_IN],
    /// scaling to correct for the windowing function
    window_scale_outputs: f32,
}

impl<const SAMPLE_IN: usize, const FFT_IN: usize, const FFT_OUT: usize, WI: Window<FFT_IN>>
    BufferedFFT<SAMPLE_IN, FFT_IN, FFT_OUT, WI>
{
    /// Use this when you want the buffered fft to be statically allocated.
    /// You MUST call `init` on this before using it!
    /// TODO: figure out how to call init on this from const. or at least how to make sure init gets called
    pub const fn uninit() -> Self {
        assert!(SAMPLE_IN > 0);
        assert!(FFT_IN / 2 == FFT_OUT);
        assert!(FFT_IN % SAMPLE_IN == 0);

        Self {
            sample_buf: CircularBuffer::new(),
            fft_buf: [0.0; FFT_IN],
            input_window: PhantomData::<WI>,
            window_scale_inputs: [1.0; FFT_IN],
            window_scale_outputs: 1.0,
        }
    }

    /// create an initialized buffered fft.
    /// useful if you don't need this statically allocated.
    /// `init` is called for you.
    pub fn new() -> Self {
        let mut x = Self::uninit();

        x.init();

        x
    }

    /// we will crash if the fft is called before the sample buffer is full! Call init to fill the buffer and do other necessary setup.
    /// TODO: use types to make sure this function is called after uninit!
    /// TODO: need some tests on these outputs
    pub fn init(&mut self) {
        self.sample_buf.fill(0.0);

        // use this to undo the reduction from the window scaling
        self.window_scale_outputs = WI::output_scaling();

        WI::apply_windows(&mut self.window_scale_inputs);
    }

    pub fn push_samples(&mut self, samples: &Samples<SAMPLE_IN>) {
        self.sample_buf.extend_from_slice(&samples.0)
    }
}

/// TODO: replace this with some macros
const HARD_CODED_FFT_INPUTS: usize = 4096;
const HARD_CODED_FFT_OUTPUTS: usize = HARD_CODED_FFT_INPUTS / 2;

/// TODO: macro for this so we can support multiple rfft sizes. or maybe a different library that does more at runtime?
impl<const SAMPLE_IN: usize, WI: Window<HARD_CODED_FFT_INPUTS>>
    BufferedFFT<SAMPLE_IN, HARD_CODED_FFT_INPUTS, HARD_CODED_FFT_OUTPUTS, WI>
{
    /// fill the fft buffer with the latest samples and then apply the windowing function
    /// remember to apply window scaling later!
    fn fill_fft_buf_with_windows(&mut self) {
        // first, we load buffer up with the samples (TODO: move this to a helper function?)
        let (a, b) = self.sample_buf.as_slices();
        self.fft_buf[..a.len()].copy_from_slice(a);
        self.fft_buf[a.len()..].copy_from_slice(b);

        for (x, w) in self.fft_buf.iter_mut().zip(self.window_scale_inputs.iter()) {
            *x *= w;
        }
    }

    /// TODO: not sure what type to put here for the output? WeightedOutputs?
    /// TODO: what should this function be called?
    pub fn fft(&mut self) -> FftOutputs<'_, HARD_CODED_FFT_OUTPUTS> {
        self.fill_fft_buf_with_windows();

        // TODO: yield here with a specific compile time feature
        // TODO: test if we need this and where
        #[cfg(feature = "std")]
        yield_now();

        let spectrum = microfft::real::rfft_4096(&mut self.fft_buf);

        // TODO: yield here with a specific compile time feature
        #[cfg(feature = "std")]
        yield_now();

        // from the README of microfft:
        // > since the real-valued coefficient at the Nyquist frequency is packed into the
        //>  imaginary part of the DC bin, it must be cleared before computing the amplitudes
        // TODO: what does this even mean?
        // TODO: print this once per second. need an every_n_milliseconds macro like fastled has
        debug!(
            "real-valued coefficient at nyquist frequency: {}",
            spectrum[0].im
        );
        spectrum[0].im = 0.0;

        debug!("dc bin: {}", spectrum[0].re);

        // correct for the windowing function
        for s in spectrum.iter_mut() {
            *s *= self.window_scale_outputs;
        }

        FftOutputs { spectrum }
    }
}

/// Convert a spectrum into channels made up of varying amounts of bins
/// TODO: something special for the first bin?
/// TODO: i'm not really liking this. its spaghetti now. this probably belons on the aggregated amplitude builders.
pub struct FftOutputs<'fft, const FFT_OUTPUT: usize> {
    spectrum: &'fft [Complex<f32>; FFT_OUTPUT],
}

impl<'a, const FFT_OUTPUT: usize> FftOutputs<'a, FFT_OUTPUT> {
    /// TODO: really not sure about this
    #[inline]
    pub fn iter_amplitude(&self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| {
            // calculate the magnitude of the sample
            s.norm()
        })
    }

    /// TODO: really not sure about this
    #[inline]
    pub fn iter_power(&self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| {
            // calculate the square of the magnitude of the sample (this is faster because norm needs a sqrt)
            s.norm_sqr()
        })
    }

    #[inline]
    pub fn iter_mean_square_power_density(&self) -> impl Iterator<Item = f32> {
        self.iter_power()
            .map(|p| p / (FFT_OUTPUT * FFT_OUTPUT) as f32)
    }

    /*
    pub fn weighted_power(&self) -> impl Iterator<Item = f32> {
        self.spectrum
            .iter()
            .zip(self.bin_counts.iter())
            .map(|(s, bin_count)| {
                let power = (s * self.window_scaling).norm_sqr();
                let divisor = (bin_count.pow(2)) as f32;

                power / divisor
            })
    }

    pub fn weighted_sound_pressure_level(&self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| todo!())
    }

    pub fn weighted_amplitude_rms(&self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| todo!())
    }

    pub fn weighted_power_rms(&self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| todo!())
    }

    pub fn weighted_peak(&self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| todo!())
    }

    pub fn weighted_peak_rms(&mut self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| todo!())
    }
     */
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
