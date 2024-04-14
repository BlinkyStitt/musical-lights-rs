use crate::logging::trace;
use circular_buffer::CircularBuffer;

use super::samples::Samples;

/// buffer audio samples. might be read from a microphone wire to an ADC, or over i2s, or from anything
/// outputs windowed samples for an FFT
pub struct AudioBuffer<const SAMPLES: usize, const BUF: usize> {
    count: usize,
    buffer: CircularBuffer<BUF, f32>,
}

impl<const S: usize, const BUF: usize> AudioBuffer<S, BUF> {
    pub fn new() -> Self {
        // TODO: compile time assert
        assert!(BUF >= S);

        // start with a buffer full of zeroes, NOT an empty buffer
        let sample_buffer = CircularBuffer::from([0.0; BUF]);

        Self {
            count: 0,
            buffer: sample_buffer,
        }
    }

    pub fn samples(&self) -> Samples<BUF> {
        // TODO: this could probably be more efficient. benchmark. i think two refs might be better than copying. or maybe this should take a &mut [f32; BUF]
        let mut samples = [0.0; BUF];

        let (a, b) = self.buffer.as_slices();

        samples[..a.len()].copy_from_slice(a);
        samples[a.len()..].copy_from_slice(b);

        let samples = Samples(samples);

        trace!("{:?}", samples);

        samples
    }

    /// returns true if the buffer has been filled with enough values
    /// WARNING! BE CAREFUL COMBINGING THIS WITH `push_samples`. its best to use one or the other or you might not get true/false when you expect!
    pub fn push_sample(&mut self, sample: f32) -> bool {
        self.count += 1;

        self.buffer.push_back(sample);

        // TODO: instead of mod, it would be safest to do >= and then reset to 0. but thats slower
        self.count % S == 0
    }

    pub fn push_samples(&mut self, samples: Samples<S>) {
        trace!("new samples: {:?}", samples);

        self.count += samples.0.len();

        self.buffer.extend_from_slice(&samples.0);
    }
}

impl<const S: usize, const BUF: usize> Default for AudioBuffer<S, BUF> {
    fn default() -> Self {
        Self::new()
    }
}
