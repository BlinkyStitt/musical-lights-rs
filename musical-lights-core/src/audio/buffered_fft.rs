use crate::logging::{info, warn};
use crate::{audio::Samples, windows::Window};
use circular_buffer::CircularBuffer;

/// put a circular buffer in front of an FFT. Use windowing to make the middle of the middle window more important.
/// TODO: think more about a-weighting
pub struct BufferedFFT<
    const SAMPLE_IN: usize,
    const FFT_IN: usize,
    const FFT_OUT: usize,
    W: Window<FFT_IN>,
> {
    /// TODO: box this? or will this always be statically allocated?
    sample_buf: CircularBuffer<FFT_IN, f32>,
    /// TODO: think more about this
    window: W,
    /// TODO: think more about this
    fft_buf: [f32; FFT_IN],
    // /// TODO: think more about this
    // fft_complex_output_buf: [Complex<f32>; FFT_OUT],
}

impl<const SAMPLE_IN: usize, const FFT_IN: usize, const FFT_OUT: usize, W: Window<FFT_IN>>
    BufferedFFT<SAMPLE_IN, FFT_IN, FFT_OUT, W>
{
    /// TODO: figure out how to call init on this from const. or at least how to make sure init gets called
    pub const fn new(window: W) -> Self {
        assert!(SAMPLE_IN > 0);
        assert!(FFT_IN / 2 == FFT_OUT);
        assert!(FFT_IN % SAMPLE_IN == 0);

        Self {
            sample_buf: CircularBuffer::new(),
            window,
            fft_buf: [0.0; FFT_IN],
            // fft_complex_output_buf: [Complex::ZERO; FFT_OUT],
        }
    }

    /// use builder pattern to ensure that fill_zero is called before the buffer is used. be sure this is zero cost!
    pub fn fill_zero(&mut self) {
        self.sample_buf.fill(0.0);
    }

    pub fn push_samples(&mut self, samples: &Samples<SAMPLE_IN>) {
        self.sample_buf.extend_from_slice(&samples.0)
    }

    #[inline]
    pub fn window_scaling(&self) -> f32 {
        W::scaling()
    }
}

/// TODO: macro for this so we can support multiple rfft sizes. or maybe a different library that does more at runtime?
impl<const SAMPLE_IN: usize, W: Window<2048>> BufferedFFT<SAMPLE_IN, 2048, 1024, W> {
    /// TODO: not sure what type to put here for the output
    /// TODO: what should this function be called?
    pub fn fft(&mut self, output: &mut [f32; 1024]) {
        // first, we load buffer up with the samples (TODO: move this to a helper function)
        let (a, b) = self.sample_buf.as_slices();

        self.fft_buf[..a.len()].copy_from_slice(a);
        self.fft_buf[a.len()..].copy_from_slice(b);

        // info!("length: {} {} {}", a.len(), b.len(), self.fft_buf.len());

        // todo: apply the window to the fft_buf
        // self.window.something(&mut self.fft_buf)

        let spectrum = microfft::real::rfft_2048(&mut self.fft_buf);

        // since the real-valued coefficient at the Nyquist frequency is packed into the
        // imaginary part of the DC bin, it must be cleared before computing the amplitudes
        spectrum[0].im = 0.0;

        for (x, &spectrum) in output.iter_mut().zip(spectrum.iter()) {
            *x = spectrum.norm();

            // TODO: need to apply something to offset the windowing?
            // TODO: need to apply something for weighting. lets default to a-weighting
        }

        // TODO: what do we do here? how do we do all the conversion steps with using as few buffers as possible?
    }
}
