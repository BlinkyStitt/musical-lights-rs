//! Bounded physical ball sizes in metres, independent of the renderer/solver.
pub const MAX_BALLS: usize = 16;
pub const MIN_DIAMETER: f32 = 0.0264;
pub const MAX_DIAMETER: f32 = 0.192;
pub const SIZE_RATIOS: [f32; 8] = [0.55, 1.4, 2.2, 0.8, 3.1, 1.0, 4.0, 1.8];

// Interval mapping is monotone, so the profile order is reusable for every size.
const PACK_ORDER: [usize; MAX_BALLS] = {
    let mut order = [0; MAX_BALLS];
    let mut i = 0;
    while i < MAX_BALLS {
        order[i] = i;
        i += 1;
    }
    i = 0;
    while i < MAX_BALLS {
        let mut j = i + 1;
        while j < MAX_BALLS {
            if SIZE_RATIOS[order[j] % SIZE_RATIOS.len()] > SIZE_RATIOS[order[i] % SIZE_RATIOS.len()]
            {
                order.swap(i, j);
            }
            j += 1;
        }
        i += 1;
    }
    order
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BallSettings {
    pub count: usize,
    pub small: f32,
    pub big: f32,
}
impl Default for BallSettings {
    fn default() -> Self {
        Self {
            count: 8,
            small: MIN_DIAMETER,
            big: MAX_DIAMETER,
        }
    }
}
impl BallSettings {
    pub fn valid(self) -> bool {
        self.count <= MAX_BALLS
            && self.small.is_finite()
            && self.big.is_finite()
            && self.small >= MIN_DIAMETER
            && self.big <= MAX_DIAMETER
            && self.small <= self.big
    }
    /// Stable index identity; additional balls repeat the original relative profile.
    pub fn diameter(self, index: usize) -> f32 {
        let ratio = SIZE_RATIOS[index % SIZE_RATIOS.len()];
        if self.small == MIN_DIAMETER && self.big == MAX_DIAMETER {
            return ratio * 0.048;
        }
        self.small + (self.big - self.small) * ((ratio - 0.55) / 3.45)
    }
    pub fn largest(self) -> f32 {
        (0..self.count)
            .map(|i| self.diameter(i))
            .fold(0.0, f32::max)
    }
    /// Six columns fit even the largest approved diameter across the 1.2 m room.
    pub fn stack_height(self) -> f32 {
        let mut height = 0.0;
        let mut rank: usize = 0;
        for index in PACK_ORDER {
            if index < self.count {
                if rank.is_multiple_of(6) {
                    height += self.diameter(index) + 0.002;
                }
                rank += 1;
            }
        }
        height
    }

    /// Stack plus floor/ceiling clearance and a small amount of bar travel.
    pub fn packed_height(self) -> f32 {
        self.stack_height() + 0.012
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sizes_preserve_identity_and_bounds() {
        let defaults = BallSettings::default();
        for i in 0..MAX_BALLS {
            assert_eq!(defaults.diameter(i), SIZE_RATIOS[i % 8] * 0.048);
            assert_eq!(
                BallSettings {
                    small: 0.1,
                    big: 0.1,
                    ..defaults
                }
                .diameter(i),
                0.1
            );
        }
        for count in 0..=MAX_BALLS {
            let settings = BallSettings { count, ..defaults };
            let mut sorted = [0.0; MAX_BALLS];
            for (i, value) in sorted.iter_mut().take(count).enumerate() {
                *value = settings.diameter(i);
            }
            sorted.sort_unstable_by(|a, b| b.total_cmp(a));
            let expected: f32 = sorted[..count].chunks(6).map(|row| row[0] + 0.002).sum();
            assert_eq!(settings.stack_height(), expected);
        }
        assert!(
            !BallSettings {
                small: f32::NAN,
                ..defaults
            }
            .valid()
        );
        assert!(
            !BallSettings {
                count: 17,
                ..defaults
            }
            .valid()
        );
        assert!(
            !BallSettings {
                small: 0.15,
                big: 0.1,
                ..defaults
            }
            .valid()
        );
        assert!(
            BallSettings {
                count: 0,
                ..defaults
            }
            .valid()
        );
        assert!(
            BallSettings {
                count: 16,
                ..defaults
            }
            .valid()
        );
    }
}
