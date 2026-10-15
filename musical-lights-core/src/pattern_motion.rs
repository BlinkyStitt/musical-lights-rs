//! Bounded accelerometer controls. Body axes: X right, Y up the display, Z out.
//! Low-pass support acceleration estimates tilt; its residual drives shake.
use crate::{
    message::{L2, L4, Motion},
    provisioning::Coefficients,
    sensor_mount::ImuMounts,
};
use nalgebra::Vector3;
use num::Float;

pub const MOTION_FRESH_MS: u64 = 100;
const G: f64 = 9.80665;

#[derive(Default)]
pub struct MotionEstimator {
    gravity: [f64; 3],
    last: Option<(u64, u32)>,
    shake: f64,
}
impl MotionEstimator {
    /// Call only for a new accelerometer sample. Calibration changes and gaps
    /// acquire a new baseline without turning that change into a shake.
    pub fn update(
        &mut self,
        accel: [f64; 3],
        saturated: bool,
        calibration: Option<&Coefficients>,
        mounts: ImuMounts,
        at: u64,
    ) -> Motion {
        let revision = calibration.map_or(0, |c| c.revision.get());
        let calibrated = core::array::from_fn(|i| {
            calibration.map_or(accel[i], |c| {
                (accel[i] - c.accel_bias[i].get() as f64) * c.accel_scale[i].get() as f64
            })
        });
        let body = mounts.accelerometer.to_body(Vector3::from(calibrated));
        let acceleration = [body.x, body.y, body.z];
        if saturated
            || acceleration
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 8.0 * G)
        {
            *self = Self::default();
            return Motion::default();
        }
        let dt = self.last.and_then(|(previous, old_revision)| {
            (revision == old_revision && at > previous && at - previous <= MOTION_FRESH_MS)
                .then_some((at.saturating_sub(previous)) as f64 / 1000.0)
        });
        if let Some(dt) = dt {
            let follow = 1.0 - Float::exp(-dt / 0.35);
            let residual = acceleration
                .iter()
                .zip(&self.gravity)
                .map(|(a, g)| (a - g) * (a - g))
                .sum::<f64>();
            self.shake = (self.shake * Float::exp(-dt / 0.25)).max(Float::sqrt(residual));
            for (g, a) in self.gravity.iter_mut().zip(acceleration) {
                *g += follow * (a - *g);
            }
        } else {
            self.gravity = acceleration;
            self.shake = 0.0;
        }
        self.last = Some((at, revision));
        let mg = |v: f64| L2::new(Float::round(v / G * 1000.0) as i16 as u16);
        Motion {
            acceleration: acceleration.map(mg),
            gravity: self.gravity.map(mg),
            shake: L2::new(Float::round(self.shake / G * 1000.0).min(16000.0) as u16),
            captured_at: L4::new(at as u32),
            age: L2::new(0),
            quality: if calibration.is_some() { 2 } else { 1 },
            calibration_revision: L4::new(revision),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PatternMotion {
    /// Direction toward the low edge, bounded to [-1, 1].
    pub tilt: [f64; 2],
    /// Short, bounded shake envelope in [0, 1].
    pub shake: f32,
}
impl PatternMotion {
    pub fn from_sample(sample: Motion, elapsed_ms: u64) -> Self {
        let age = (sample.age.get() as u64).saturating_add(elapsed_ms);
        if !sample.valid() || sample.quality == 0 || age > MOTION_FRESH_MS {
            return Self::default();
        }
        let gravity = sample.gravity.map(|v| v.get() as i16 as f64);
        let length = Float::sqrt(gravity.iter().map(|v| v * v).sum::<f64>());
        // Free fall has no reliable tilt direction.
        let tilt = if length >= 250.0 {
            [-gravity[0] / length, -gravity[1] / length]
        } else {
            [0.0; 2]
        };
        Self {
            tilt,
            shake: (((sample.shake.get() as f64 - 150.0) / 1500.0).clamp(0.0, 1.0)
                * Float::exp(-(elapsed_ms as f64) / 250.0)) as f32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_gaps_invalid_samples_and_revision_changes_do_not_make_shakes() {
        let mut estimator = MotionEstimator::default();
        let mounts = ImuMounts::default();
        let sample = estimator.update([G, 0.0, 0.0], false, None, mounts, 0);
        assert_eq!(sample.shake.get(), 0);
        assert_eq!(PatternMotion::from_sample(sample, 0).tilt, [-1.0, 0.0]);
        assert_eq!(
            PatternMotion::from_sample(sample, 101),
            PatternMotion::default()
        );
        assert_eq!(
            estimator
                .update([0.0, G, 0.0], false, None, mounts, 200)
                .shake
                .get(),
            0
        );
        assert_eq!(
            estimator
                .update([f64::NAN, 0.0, G], false, None, mounts, 210)
                .quality,
            0
        );
        assert_eq!(
            estimator
                .update([0.0, 0.0, G], true, None, mounts, 220)
                .quality,
            0
        );
        let mut calibration = crate::firmware_tests::coefficients();
        assert_eq!(
            estimator
                .update([0.0, 0.0, G], false, Some(&calibration), mounts, 230)
                .shake
                .get(),
            0
        );
        calibration.revision = L4::new(2);
        assert_eq!(
            estimator
                .update([G, 0.0, 0.0], false, Some(&calibration), mounts, 240)
                .shake
                .get(),
            0
        );
    }
    #[test]
    fn mounting_calibration_and_short_shakes_reach_pattern_controls() {
        use crate::sensor_mount::{SensorMount, SignedAxis::*};
        let mounts = ImuMounts {
            accelerometer: SensorMount::from_axes([Y, NegX, Z]).unwrap(),
            ..Default::default()
        };
        let mut calibration = crate::firmware_tests::coefficients();
        calibration.accel_bias[0] = crate::provisioning::F4::new(1.0);
        let mut estimator = MotionEstimator::default();
        let first = estimator.update([1.0, 0.0, G], false, Some(&calibration), mounts, 0);
        assert_eq!(first.acceleration.map(|v| v.get() as i16), [0, 0, 1000]);
        let spike = estimator.update([1.0 + G, 0.0, G], false, Some(&calibration), mounts, 10);
        assert_eq!(spike.acceleration.map(|v| v.get() as i16), [0, 1000, 1000]);
        assert!(spike.shake.get() >= 999);
        let after = estimator.update([1.0, 0.0, G], false, Some(&calibration), mounts, 20);
        assert!(after.shake.get() > 900); // survives a short spike between UART snapshots
        assert!(PatternMotion::from_sample(after, 0).shake > 0.5);
        assert_eq!(PatternMotion::from_sample(after, 101).shake, 0.0);
    }
    #[test]
    fn tilt_and_decay_are_independent_of_sample_rate() {
        let run = |step| {
            let mut estimator = MotionEstimator::default();
            estimator.update([0.0, 0.0, G], false, None, ImuMounts::default(), 0);
            let mut last = Motion::default();
            for at in (step..=1000).step_by(step as usize) {
                last = estimator.update(
                    [G * 0.6, 0.0, G * 0.8],
                    false,
                    None,
                    ImuMounts::default(),
                    at,
                );
            }
            PatternMotion::from_sample(last, 0)
        };
        let a = run(10);
        let b = run(20);
        assert!((a.tilt[0] - b.tilt[0]).abs() < 0.002);
        assert!((a.shake - b.shake).abs() < 0.01);
    }
}
