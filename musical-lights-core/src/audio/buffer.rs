use crate::logging::trace;
use circular_buffer::CircularBuffer;

use crate::windows::Window;

use super::samples::{Samples, WindowedSamples};

/// buffer audio samples. might be read from a microphone wire to an ADC, or over i2s, or from anything
/// outputs windowed samples for an FFT
pub struct AudioBuffer<const SAMPLES: usize, const BUF: usize> {
    count: usize,
    buffer: CircularBuffer<BUF, f32>,
    /// apply a window to the samples before outputing them to the FFT
    /// hanning window or similar things can be applied with this
    window_multipliers: [f32; BUF],
}

impl<const S: usize, const BUF: usize> AudioBuffer<S, BUF> {
    pub fn new<W: Window<BUF>>() -> Self {
        // TODO: compile time assert
        // assert_eq!(S, 512);
        assert!(BUF >= S);
        // assert_eq!(BINS * 2, BUF);
        // assert!(FREQ <= BINS);

        let window_multipliers = W::windows();

        // // TODO: actual equal loudness curve. use A-weighting for now. but there are other curves including an ISO standard from 2023
        // let equal_loudness_curve = [1.0; BINS];

        // start with a buffer full of zeroes, NOT an empty buffer
        let sample_buffer = CircularBuffer::from([0.0; BUF]);

        Self {
            count: 0,
            buffer: sample_buffer,
            window_multipliers,
            // equal_loudness_map: amplitude_aggregation_map,
            // equal_loudness_curve,
        }
    }

    pub fn copy_buffered_samples(&self) -> Samples<BUF> {
        // TODO: this could probably be more efficient. benchmark. i think two refs might be better than copying. or maybe this should take a &mut [f32; BUF]
        let mut samples = [0.0; BUF];

        let (a, b) = self.buffer.as_slices();

        samples[..a.len()].copy_from_slice(a);
        samples[a.len()..].copy_from_slice(b);

        let samples = Samples(samples);

        trace!("{:?}", samples);

        samples
    }

    pub fn copy_windowed_samples(&self) -> WindowedSamples<BUF> {
        let samples = self.copy_buffered_samples();

        let windowed_samples = WindowedSamples::from_samples(samples, &self.window_multipliers);

        trace!("{:?}", windowed_samples);

        windowed_samples
    }

    /// returns true if the buffer has been filled with enough values
    /// WARNING! BE CAREFUL COMBINGING THIS WITH buffer_samples. its best to use one or the other or you might not get true/false when you expect!
    pub fn buffer_sample(&mut self, sample: f32) -> bool {
        self.count += 1;

        self.buffer.push_back(sample);

        // TODO: instead of mod, it would be safest to do >= and then reset to 0. but thats slower
        self.count % S == 0
    }

    pub fn buffer_samples(&mut self, samples: Samples<S>) {
        trace!("new samples: {:?}", samples);

        self.count += samples.0.len();

        self.buffer.extend_from_slice(&samples.0);
    }
}
