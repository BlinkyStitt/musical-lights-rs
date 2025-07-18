//! Use an FFT and a circular buffer to process audio.
//!
//! I don't think this is actually what I want. Refactoring now with [`FilterBank`].
//!
//! This is the first design I used (inspired by things built with a Teensy Audio Board).

use core::marker::PhantomData;

#[cfg(feature = "std")]
use std::thread::yield_now;

use crate::{
    audio::{Samples, Weighting},
    logging::trace,
    windows::Window,
};
use circular_buffer::CircularBuffer;
use num::Complex;

/// put a circular buffer in front of an FFT. Use windowing to make the middle of the middle window more important.
pub struct BufferedFFT<
    const SAMPLE_IN: usize,
    const FFT_IN: usize,
    const FFT_OUT: usize,
    WI: Window<FFT_IN>,
    WE: Weighting<FFT_OUT>,
> {
    /// TODO: need a test that adds to the circular buffer and makes sure it wraps around like we want
    sample_buf: CircularBuffer<FFT_IN, f32>,
    /// TODO: this should be the existing FFT object so we can reuse that code. it wasn't built with buffers in mind most of the time though. not a terrible refactor
    fft_in_buf: [f32; FFT_IN],
    input_window: PhantomData<WI>,
    scale_inputs: [f32; FFT_IN],
    /// scaling to correct for the windowing function and equal loudness countours.
    /// Collapses to a single-sided spectrum (bins 1…N/2-1) by doubling power there; leave DC (k = 0) and Nyquist (k = N/2) unchanged.
    /// TODO: double check this. too much cargo culting
    /// TODO: WE should just own weights itself
    weighting: WE,
    scale_outputs: [f32; FFT_OUT],
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
    /// You MUST call `init` on this before using it!
    /// TODO: figure out how to call init on this from const. or at least how to make sure init gets called
    pub const fn uninit(weighting: WE) -> Self {
        assert!(SAMPLE_IN > 0);
        assert!(FFT_IN / 2 == FFT_OUT);
        assert!(FFT_IN.is_multiple_of(SAMPLE_IN));

        Self {
            sample_buf: CircularBuffer::new(),
            fft_in_buf: [0.0; FFT_IN],
            input_window: PhantomData::<WI>,
            scale_inputs: [1.0; FFT_IN],
            weighting,
            scale_outputs: [1.0; FFT_OUT],
        }
    }

    /// create an initialized buffered fft.
    /// useful if you don't need this statically allocated.
    /// `init` is called for you.
    /// TODO: refactor the window to be const and then we can make this const
    pub fn new(weighting: WE) -> Self {
        let mut x = Self::uninit(weighting);

        x.init();

        x
    }

    /// we will crash if the fft is called before the sample buffer is full! Call init to fill the buffer and do other necessary setup.
    /// TODO: use types to make sure this function is called after uninit!
    /// TODO: need some tests on these outputs
    pub fn init(&mut self) {
        self.sample_buf.fill(0.0);

        // the inputs are reduced by the windowing function
        WI::apply_windows(&mut self.scale_inputs);

        // this undoes the reduction from the window scaling
        let window_output_scaling = WI::output_scaling();

        self.weighting.curve_buf(&mut self.scale_outputs);

        // TODO: i think we should skip the last bin, but that's not looking right
        for we in self.scale_outputs.iter_mut() {
            *we *= window_output_scaling;
        }

        self.scale_outputs[0] = 1.0;
    }

    /// fill the fft buffer with the latest samples and then apply the windowing function
    /// remember to apply window scaling later!
    fn fill_fft_in_buf(&mut self) {
        // first, we load buffer up with the samples (TODO: move this to a helper function?)
        let (a, b) = self.sample_buf.as_slices();
        self.fft_in_buf[..a.len()].copy_from_slice(a);
        self.fft_in_buf[a.len()..].copy_from_slice(b);

        for (x, wi) in self.fft_in_buf.iter_mut().zip(self.scale_inputs.iter()) {
            *x *= wi;
        }
    }

    pub fn push_samples(&mut self, samples: &Samples<SAMPLE_IN>) {
        self.sample_buf.extend_from_slice(&samples.0)
    }
}

/// TODO: replace this with some macros
const HARD_CODED_FFT_INPUTS: usize = 4096;
const HARD_CODED_FFT_OUTPUTS: usize = HARD_CODED_FFT_INPUTS / 2;

/// TODO: macro for this so we can support multiple rfft sizes. or maybe a different library that does more at runtime?
impl<
    const SAMPLE_IN: usize,
    WI: Window<HARD_CODED_FFT_INPUTS>,
    WE: Weighting<HARD_CODED_FFT_OUTPUTS>,
> BufferedFFT<SAMPLE_IN, HARD_CODED_FFT_INPUTS, HARD_CODED_FFT_OUTPUTS, WI, WE>
{
    /// TODO: not sure what type to put here for the output? WeightedOutputs?
    /// TODO: what should this function be called?
    pub fn fft(&mut self) -> FftOutputs<'_, HARD_CODED_FFT_OUTPUTS> {
        self.fill_fft_in_buf();

        // TODO: yield here with a specific compile time feature
        // TODO: test if we need this and where
        #[cfg(feature = "std")]
        yield_now();

        let spectrum = microfft::real::rfft_4096(&mut self.fft_in_buf);

        // TODO: yield here with a specific compile time feature
        #[cfg(feature = "std")]
        yield_now();

        // from the README of microfft:
        // > since the real-valued coefficient at the Nyquist frequency is packed into the
        //>  imaginary part of the DC bin, it must be cleared before computing the amplitudes
        // TODO: what does this even mean?
        // TODO: print this once per second. need an every_n_milliseconds macro like fastled has
        trace!(
            "real-valued coefficient at nyquist frequency: {}",
            spectrum[0].im
        );
        spectrum[0].im = 0.0;

        trace!("dc bin: {}", spectrum[0].re);

        // TODO: this is causing a stack overflow. can't we just give more task size?
        // correct for the windowing function
        // TODO: is there a simd or something for this?
        // TODO: doing this here uses a bunch of staack space. maybe better to do after we make the conversion to magnitude
        for (s, we) in spectrum.iter_mut().zip(self.scale_outputs) {
            *s *= we;
        }

        // correct for the weighting function
        // TODO: i'm really unsure if we should be doing this now or later. i think a-weighting is actually the wrong thing to use since we aren't measuring in SPL
        FftOutputs { spectrum }
    }
}

/// Convert a spectrum into channels made up of varying amounts of bins
/// TODO: something special for the first bin?
/// TODO: i'm not really liking this. its spaghetti now. this probably belons on the aggregated amplitude builders.
#[repr(transparent)]
pub struct FftOutputs<'fft, const FFT_OUTPUT: usize> {
    spectrum: &'fft [Complex<f32>; FFT_OUTPUT],
}

impl<'a, const FFT_OUTPUT: usize> FftOutputs<'a, FFT_OUTPUT> {
    /// TODO: the weights aren't included! is that okay?
    #[inline]
    pub fn spectrum(&self) -> &[Complex<f32>; FFT_OUTPUT] {
        self.spectrum
    }

    /// calculate the magnitude of the sample
    /// TODO: really not sure about this
    #[inline]
    pub fn iter_amplitude(&self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| s.norm())
    }

    /// calculate the square of the magnitude of the sample (this is faster because norm needs a sqrt)
    /// TODO: really not sure about this
    /// TODO: THIS IS NOT WEIGHTED! BE SURE TO ADD THAT!
    #[inline]
    pub fn iter_power(&self) -> impl Iterator<Item = f32> {
        self.spectrum.iter().map(|s| s.norm_sqr())
    }

    /// i think this is what we actually want to use. but i'm really not sure
    /// This **IS** Weighted. Maybe this should be another function?
    /// TODO: read more
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

pub const fn bin_to_frequency(bin_index: usize, sample_rate_hz: f32, num_bins: usize) -> f32 {
    (bin_index as f32) * sample_rate_hz / ((num_bins * 2) as f32)
}

pub const fn frequency_to_bin(frequency: f32, sample_rate_hz: f32, num_bins: usize) -> usize {
    // // NOTE: this can't be const because of round
    // ((frequency * (num_bins * 2) as f32) / sample_rate_hz).round() as usize
    (((frequency * (num_bins * 2) as f32) / sample_rate_hz) + 0.5) as usize
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

    #[test]
    fn test_bin_and_frequency() {
        let sample_rate_hz = 44_100.0;

        let num_bins = 2048;

        for i in 0..num_bins {
            let frequency = bin_to_frequency(i, sample_rate_hz, num_bins);

            let j = frequency_to_bin(frequency, sample_rate_hz, num_bins);

            println!("{i} = {frequency} = {j}");

            assert_eq!(i, j);
        }
    }
}
