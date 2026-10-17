//! Periodic flat bar tops connected by straight, gap-free joins.

/// A join spans the former 2 mm gap in a 50 mm source pitch.
/// Keep the source top flat over the remaining pitch.
pub const JOIN_FRACTION: f64 = 0.04;

#[derive(Clone, Copy, Debug)]
pub struct BarSurface<const N: usize> {
    heights: [f64; N],
}

impl<const N: usize> BarSurface<N> {
    pub fn new(heights: &[f64; N]) -> Self {
        assert!(N > 1);
        Self { heights: *heights }
    }

    /// Sample from this band centre to the next. Only the gap slopes.
    pub fn sample(&self, band: usize, fraction: f64) -> f64 {
        let start = (1.0 - JOIN_FRACTION) / 2.0;
        let blend = ((fraction - start) / JOIN_FRACTION).clamp(0.0, 1.0);
        self.heights[band % N] * (1.0 - blend) + self.heights[(band + 1) % N] * blend
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_tops_and_join_midpoints_preserve_source_heights_at_the_wrap() {
        let heights = [0.003, 0.8, 0.9, 0.4, 0.4, 0.1];
        let surface = BarSurface::new(&heights);
        for i in 0..heights.len() {
            let next = (i + 1) % heights.len();
            for fraction in [0.0, 0.25, 0.48] {
                assert_eq!(surface.sample(i, fraction), heights[i]);
            }
            for fraction in [0.52, 0.75, 1.0] {
                assert_eq!(surface.sample(i, fraction), heights[next]);
            }
            assert!((surface.sample(i, 0.5) - (heights[i] + heights[next]) / 2.0).abs() < 1e-14);
        }
    }

    #[test]
    fn alternating_extremes_and_flat_bands_cannot_overshoot() {
        for heights in [[0.0, 1.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0], [1.0; 4]] {
            let surface = BarSurface::new(&heights);
            for i in 0..4 {
                let next = (i + 1) % 4;
                let low = heights[i].min(heights[next]);
                let high = heights[i].max(heights[next]);
                for j in 0..=1000 {
                    let height = surface.sample(i, j as f64 / 1000.0);
                    assert!((low - 1e-14..=high + 1e-14).contains(&height));
                }
            }
        }
    }

    #[test]
    fn joins_are_straight_and_continuous_between_flat_tops() {
        let heights = [0.003, 0.0031, 0.9, 0.91, 0.1];
        let surface = BarSurface::new(&heights);
        let start = (1.0 - JOIN_FRACTION) / 2.0;
        for i in 0..heights.len() {
            let next = (i + 1) % heights.len();
            for j in 0..=1000 {
                let blend = j as f64 / 1000.0;
                let actual = surface.sample(i, start + blend * JOIN_FRACTION);
                let expected = heights[i] * (1.0 - blend) + heights[next] * blend;
                assert!((actual - expected).abs() < 2e-14);
            }
        }
    }
}
