pub struct PeakScaledBuilder {
    pub max: f32,
    pub decay_per_tick: f32,
    pub min: f32,
}

impl PeakScaledBuilder {
    pub fn new(decay_per_tick: f32) -> Self {
        Self {
            max: f32::MIN,
            decay_per_tick,
            min: f32::MAX,
        }
    }

    /// update min and max for the full range, then scale the values at `x`
    pub fn scale(&mut self, x: &mut [f32]) {
        let mut new_min = self.min;
        let mut new_max = self.max;

        for x in x.iter().copied() {
            new_min = new_min.min(x);
            new_max = new_max.max(x);
        }

        // update min and max
        self.min = self.min.min(new_min);
        self.max = self.max.max(new_max);

        // scale all the values with the new mins and maxes
        for x in x.iter_mut() {
            *x = self.scale_one(*x);
        }

        // decay min and max
        // TODO: i don't think we need saturating add/sub, but think about it more. it's also not available in no_std
        self.min = new_min + self.decay_per_tick;
        self.max = new_max - self.decay_per_tick;
    }

    /// only call this through [scale]! this makes sure min and max are correct
    #[inline]
    fn scale_one(&self, x: f32) -> f32 {
        (x - self.min) / (self.max - self.min)
    }
}
