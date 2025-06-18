use circular_buffer::CircularBuffer;

use super::samples::Samples;

/// buffer audio samples. might be read from a microphone wire to an ADC, or over i2s, or from anything
/// outputs windowed samples for an FFT
pub struct AudioBuffer<const IN: usize, const OUT: usize> {
    count: usize,
    buffer: CircularBuffer<OUT, f32>,
}

impl<const IN: usize, const OUT: usize> AudioBuffer<IN, OUT> {
    #[deprecated = "use BufferedFFT instead"]
    pub const fn new() -> Self {
        // TODO: what is this the right way to do a compile time assert
        assert!(OUT >= IN);
        assert!(OUT % IN == 0);

        let sample_buffer = CircularBuffer::new();

        // TODO: should we start with a buffer full of zeroes, NOT an empty buffer? this can't be const then
        // sample_buffer.fill(0.0);

        Self {
            count: 0,
            buffer: sample_buffer,
        }
    }

    pub fn fill(&mut self) {
        self.buffer.fill(0.0);
    }

    /// TODO: can we do this without creating a whole new array?
    /// TODO: option to return samples in a box?
    pub fn samples(&self) -> Samples<OUT> {
        // TODO: this could probably be more efficient. benchmark. i think two refs might be better than copying. or maybe this should take a &mut [f32; BUF]
        let mut samples = Samples([0.0; OUT]);

        Self::samples_in_place(self, &mut samples);

        samples
    }

    /// TODO: think more about this. maybe we actually just want an iter
    #[inline]
    pub fn samples_in_place(&self, samples: &mut Samples<OUT>) {
        let (a, b) = self.buffer.as_slices();

        samples.0[..a.len()].copy_from_slice(a);
        samples.0[a.len()..].copy_from_slice(b);
    }

    #[inline]
    pub fn samples_iter(&self) -> impl Iterator<Item = &f32> {
        self.buffer.iter()
    }

    /// returns true if the buffer has been filled with enough values
    /// WARNING! BE CAREFUL COMBINGING THIS WITH `push_samples`. its best to use one or the other or you might not get true/false when you expect!
    pub fn push_sample(&mut self, sample: f32) -> bool {
        self.count += 1;

        self.buffer.push_back(sample);

        // TODO: instead of mod, it would be safest to do >= and then reset to 0. but thats slower
        // TODO: is IN the right value to check? we might want sample rate if IN has to be small because of hardware constraints
        self.count % IN == 0
    }

    pub fn push_samples(&mut self, samples: &Samples<IN>) {
        // trace!("new samples: {:?}", samples);

        // TODO: why even track count? this seems unnecessary
        self.count += samples.0.len();

        self.buffer.extend_from_slice(&samples.0);
    }
}

impl<const S: usize, const BUF: usize> Default for AudioBuffer<S, BUF> {
    fn default() -> Self {
        Self::new()
    }
}
