//! Periodic, shape-preserving cubic joins between band centres.
//!
//! The independent band heights remain the interpolation knots. Harmonic-mean
//! tangents make adjoining segments C1 and prevent overshoot at peaks, troughs
//! and flat bands. Coordinates are in band pitches, with knot zero at zero.
#[derive(Clone, Copy, Debug)]
pub struct BarSurface<const N: usize> {
    coefficients: [[f64; 4]; N],
}

impl<const N: usize> BarSurface<N> {
    pub fn new(heights: &[f64; N]) -> Self {
        assert!(N > 1);
        let tangents: [f64; N] = core::array::from_fn(|i| {
            let before = heights[i] - heights[(i + N - 1) % N];
            let after = heights[(i + 1) % N] - heights[i];
            if before * after <= 0.0 {
                0.0
            } else {
                2.0 * before * after / (before + after)
            }
        });
        Self {
            coefficients: core::array::from_fn(|i| {
                let next = (i + 1) % N;
                let delta = heights[next] - heights[i];
                [
                    heights[i],
                    tangents[i],
                    3.0 * delta - 2.0 * tangents[i] - tangents[next],
                    tangents[i] + tangents[next] - 2.0 * delta,
                ]
            }),
        }
    }

    /// Cubic coefficients, in ascending powers, from this knot to the next.
    pub fn coefficients(&self, band: usize) -> [f64; 4] {
        self.coefficients[band % N]
    }

    /// Sample a single interval. The endpoint belongs to the next band centre.
    pub fn sample(&self, band: usize, fraction: f64) -> f64 {
        let [a, b, c, d] = self.coefficients(band);
        a + fraction * (b + fraction * (c + fraction * d))
    }

    pub fn slope(&self, band: usize, fraction: f64) -> f64 {
        let [_, b, c, d] = self.coefficients(band);
        b + fraction * (2.0 * c + fraction * 3.0 * d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_preserve_knots_and_tangents_including_the_periodic_seam() {
        let heights = [0.003, 0.8, 0.9, 0.4, 0.4, 0.1];
        let surface = BarSurface::new(&heights);
        for i in 0..heights.len() {
            let next = (i + 1) % heights.len();
            assert_eq!(surface.sample(i, 0.0), heights[i]);
            assert!((surface.sample(i, 1.0) - heights[next]).abs() < 1e-14);
            assert!((surface.slope(i, 1.0) - surface.slope(next, 0.0)).abs() < 1e-14);
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
    fn monotone_intervals_remain_monotone_for_uneven_heights() {
        let heights = [0.003, 0.0031, 0.9, 0.91, 0.1];
        let surface = BarSurface::new(&heights);
        for i in 0..heights.len() {
            let direction = (heights[(i + 1) % heights.len()] - heights[i]).signum();
            for j in 0..=1000 {
                assert!(surface.slope(i, j as f64 / 1000.0) * direction >= -1e-14);
            }
        }
    }
}
