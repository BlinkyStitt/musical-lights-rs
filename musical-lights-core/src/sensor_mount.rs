//! Mounting rotations from sensor coordinates S to the existing body frame B.
//! B is right-handed: X right, Y toward the top edge, Z out of the display.
//! Calibrate each sensor in its own frame before rotating it. Rotation preserves
//! units: acceleration in m/s² (support acceleration, not gravity), angular rate
//! in rad/s, and magnetic flux density in µT. This module performs no fusion.
use nalgebra::{Matrix3, Quaternion, Rotation3, UnitQuaternion, Vector3};
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignedAxis {
    X,
    NegX,
    Y,
    NegY,
    Z,
    NegZ,
}
impl SignedAxis {
    fn vector(self) -> Vector3<f64> {
        match self {
            Self::X => Vector3::new(1.0, 0.0, 0.0),
            Self::NegX => Vector3::new(-1.0, 0.0, 0.0),
            Self::Y => Vector3::new(0.0, 1.0, 0.0),
            Self::NegY => Vector3::new(0.0, -1.0, 0.0),
            Self::Z => Vector3::new(0.0, 0.0, 1.0),
            Self::NegZ => Vector3::new(0.0, 0.0, -1.0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum MountError {
    #[error("sensor axes must be distinct")]
    RepeatedAxis,
    #[error("sensor axes must form a right-handed rotation")]
    Reflection,
    #[error("mount quaternion must be finite and nonzero")]
    InvalidQuaternion,
}

/// One rotation representation: qBS maps sensor vectors into body coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SensorMount {
    rotation: UnitQuaternion<f64>,
}
impl Default for SensorMount {
    fn default() -> Self {
        Self {
            rotation: UnitQuaternion::identity(),
        }
    }
}
impl SensorMount {
    /// Body directions of the sensor's positive X, Y and Z axes, in that order.
    pub fn from_axes(axes: [SignedAxis; 3]) -> Result<Self, MountError> {
        let [x, y, z] = axes.map(SignedAxis::vector);
        if x.dot(&y) != 0.0 || x.dot(&z) != 0.0 || y.dot(&z) != 0.0 {
            return Err(MountError::RepeatedAxis);
        }
        if x.cross(&y).dot(&z) != 1.0 {
            return Err(MountError::Reflection);
        }
        let matrix = Matrix3::from_columns(&[x, y, z]);
        Ok(Self {
            rotation: UnitQuaternion::from_rotation_matrix(&Rotation3::from_matrix_unchecked(
                matrix,
            )),
        })
    }

    /// Normalize a finite, nonzero qBS. Quaternion::new takes (w, x, y, z).
    pub fn from_quaternion(q_bs: Quaternion<f64>) -> Result<Self, MountError> {
        if !q_bs.coords.iter().all(|v| v.is_finite()) {
            return Err(MountError::InvalidQuaternion);
        }
        // Scale first so normalization also accepts finite very large/tiny inputs.
        let scale = q_bs.coords.iter().map(|v| v.abs()).fold(0.0_f64, f64::max);
        if scale == 0.0 {
            return Err(MountError::InvalidQuaternion);
        }
        Ok(Self {
            rotation: UnitQuaternion::new_normalize(q_bs / scale),
        })
    }

    pub fn to_body(&self, sensor: Vector3<f64>) -> Vector3<f64> {
        self.rotation.transform_vector(&sensor)
    }
    pub fn to_sensor(&self, body: Vector3<f64>) -> Vector3<f64> {
        self.rotation.inverse_transform_vector(&body)
    }
    pub fn inverse(&self) -> Self {
        Self {
            rotation: self.rotation.inverse(),
        }
    }
    /// qWS maps sensor to world. Return body to world: qWB = qWS × inverse(qBS).
    pub fn body_attitude(&self, sensor_to_world: UnitQuaternion<f64>) -> UnitQuaternion<f64> {
        sensor_to_world * self.rotation.inverse()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SensorSamples {
    pub accelerometer: Vector3<f64>,
    pub gyro: Option<Vector3<f64>>,
    pub magnetometer: Option<Vector3<f64>>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BodySamples {
    pub accelerometer: Vector3<f64>,
    pub gyro: Option<Vector3<f64>>,
    pub magnetometer: Option<Vector3<f64>>,
}

/// Sensors can have different physical axes, even in one IMU package.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ImuMounts {
    pub accelerometer: SensorMount,
    pub gyro: SensorMount,
    pub magnetometer: SensorMount,
}
impl ImuMounts {
    /// Convert calibrated samples once, before body-frame fusion/classification.
    pub fn to_body(&self, samples: SensorSamples) -> BodySamples {
        BodySamples {
            accelerometer: self.accelerometer.to_body(samples.accelerometer),
            gyro: samples.gyro.map(|v| self.gyro.to_body(v)),
            magnetometer: samples.magnetometer.map(|v| self.magnetometer.to_body(v)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orientation::Orientation;
    use core::f64::consts::{FRAC_PI_2, PI};

    fn close(a: Vector3<f64>, b: Vector3<f64>) {
        assert!((a - b).norm() < 1e-12, "{a:?} != {b:?}");
    }
    #[test]
    fn all_24_axis_rotations_and_their_inverses() {
        let axes = [
            SignedAxis::X,
            SignedAxis::NegX,
            SignedAxis::Y,
            SignedAxis::NegY,
            SignedAxis::Z,
            SignedAxis::NegZ,
        ];
        let mut valid = 0;
        let mut reflections = 0;
        let mut repeats = 0;
        for x in axes {
            for y in axes {
                for z in axes {
                    match SensorMount::from_axes([x, y, z]) {
                        Ok(mount) => {
                            valid += 1;
                            for (input, output) in
                                [(Vector3::x(), x), (Vector3::y(), y), (Vector3::z(), z)]
                            {
                                close(mount.to_body(input), output.vector());
                            }
                            let v = Vector3::new(1.2, -3.4, 5.6);
                            close(mount.to_sensor(mount.to_body(v)), v);
                            close(mount.inverse().to_body(mount.to_body(v)), v);
                        }
                        Err(MountError::Reflection) => reflections += 1,
                        Err(MountError::RepeatedAxis) => repeats += 1,
                        Err(e) => panic!("unexpected {e:?}"),
                    }
                }
            }
        }
        assert_eq!((valid, reflections, repeats), (24, 24, 168));
    }
    #[test]
    fn arbitrary_rotations_preserve_vectors_and_attitude_composition() {
        for (roll, pitch, yaw) in [(0.3, -0.7, 1.2), (-2.1, 0.8, -0.4)] {
            let q_bs = UnitQuaternion::from_euler_angles(roll, pitch, yaw);
            let mount = SensorMount::from_quaternion(q_bs.into_inner()).unwrap();
            let q_wb = UnitQuaternion::from_euler_angles(-0.9, 1.3, 2.4);
            let q_ws = q_wb * q_bs;
            let actual = mount.body_attitude(q_ws);
            for v in [
                Vector3::x(),
                Vector3::y(),
                Vector3::z(),
                Vector3::new(0.2, -0.7, 1.3),
            ] {
                close(
                    actual.transform_vector(&mount.to_body(v)),
                    q_ws.transform_vector(&v),
                );
                close(actual.transform_vector(&v), q_wb.transform_vector(&v));
                close(mount.to_sensor(mount.to_body(v)), v);
            }
        }
    }
    #[test]
    fn quaternion_validation_and_sign_equivalence() {
        for q in [
            Quaternion::new(0.0, 0.0, 0.0, 0.0),
            Quaternion::new(f64::NAN, 1.0, 0.0, 0.0),
            Quaternion::new(1.0, f64::INFINITY, 0.0, 0.0),
        ] {
            assert_eq!(
                SensorMount::from_quaternion(q),
                Err(MountError::InvalidQuaternion)
            );
        }
        let q = Quaternion::new(1.0, 2.0, -3.0, 4.0);
        let reference = SensorMount::from_quaternion(q).unwrap();
        let v = Vector3::new(0.8, -0.4, 0.2);
        for scale in [-1.0, 1e-300, 1e300] {
            close(
                SensorMount::from_quaternion(q * scale).unwrap().to_body(v),
                reference.to_body(v),
            );
        }
    }
    #[test]
    fn independent_mounts_preserve_units_and_missing_samples() {
        let mounts = ImuMounts {
            accelerometer: SensorMount::from_axes([SignedAxis::Y, SignedAxis::NegX, SignedAxis::Z])
                .unwrap(),
            gyro: SensorMount::from_axes([SignedAxis::Z, SignedAxis::Y, SignedAxis::NegX]).unwrap(),
            magnetometer: SensorMount::from_axes([SignedAxis::X, SignedAxis::NegZ, SignedAxis::Y])
                .unwrap(),
        };
        let out = mounts.to_body(SensorSamples {
            accelerometer: Vector3::new(9.81, 0.0, 0.0),
            gyro: Some(Vector3::new(1.2, 0.0, 0.0)),
            magnetometer: Some(Vector3::new(0.0, 23.0, 0.0)),
        });
        close(out.accelerometer, Vector3::new(0.0, 9.81, 0.0));
        close(out.gyro.unwrap(), Vector3::new(0.0, 0.0, 1.2));
        close(out.magnetometer.unwrap(), Vector3::new(0.0, 0.0, -23.0));
        let absent = mounts.to_body(SensorSamples {
            accelerometer: Vector3::zeros(),
            gyro: None,
            magnetometer: None,
        });
        assert_eq!((absent.gyro, absent.magnetometer), (None, None));
    }
    #[test]
    fn mounted_six_poses_ignore_world_yaw_and_quaternion_sign() {
        let q_bs = UnitQuaternion::from_euler_angles(0.4, -0.8, 1.1);
        let mount = SensorMount::from_quaternion(q_bs.into_inner()).unwrap();
        for (roll, pitch, pose) in [
            (0.0, 0.0, Orientation::FaceUp),
            (PI, 0.0, Orientation::FaceDown),
            (FRAC_PI_2, 0.0, Orientation::TopUp),
            (-FRAC_PI_2, 0.0, Orientation::TopDown),
            (0.0, FRAC_PI_2, Orientation::LeftUp),
            (0.0, -FRAC_PI_2, Orientation::RightUp),
        ] {
            for yaw in [0.0, 0.7, -2.4] {
                let q_ws = UnitQuaternion::from_euler_angles(roll, pitch, yaw) * q_bs;
                for q in [q_ws, UnitQuaternion::new_unchecked(-q_ws.into_inner())] {
                    assert_eq!(Orientation::from_quat(&mount.body_attitude(q)), pose);
                    let g =
                        mount.to_body(q.inverse_transform_vector(&Vector3::new(0.0, 0.0, -9.81)));
                    assert_eq!(Orientation::from_gravity(g.x, g.y, g.z), pose);
                }
            }
        }
    }
}
