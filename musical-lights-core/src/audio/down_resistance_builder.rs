//! TODO: i don't like this very much

/// limit how fast a value can decrease
/// TODO: have it decelerate like with gravity
/// TODO: think more about this
pub struct DownResistanceBuilder<const N: usize> {
    /// max rate that a value can decrease
    rate: f32,
    buffer: [f32; N],
}

impl<const N: usize> DownResistanceBuilder<N> {
    pub fn new(rate: f32) -> Self {
        Self {
            rate,
            buffer: [0.0; N],
        }
    }

    pub fn update(&mut self, values: &mut [f32; N]) {
        for (b, v) in self.buffer.iter_mut().zip(values.iter_mut()) {
            *v = b.max(*v);

            *b = (*v - self.rate).max(0.0);
        }
    }
}
