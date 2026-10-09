//! Right-handed device frame: X right, Y toward the top edge, Z out of the display.
//! Quaternions map device coordinates to world coordinates; world gravity is -Z.
use num::Float;
use postcard::experimental::max_size::MaxSize;
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Copy, Clone, Debug, Default, Serialize, Deserialize, MaxSize, PartialEq)]
pub enum Orientation {
    /// Device is lying flat with screen/display facing upward
    FaceUp,
    /// Device is lying flat with screen/display facing downward
    FaceDown,
    /// Top edge of the device is pointing upward
    TopUp,
    /// Top edge of the device is pointing downward
    TopDown,
    /// Left side of the device is pointing upward
    LeftUp,
    /// Right side of the device is pointing upward
    RightUp,
    /// Orientation is unclear or in transition
    #[default]
    Unknown,
}

impl Orientation {
    /// Rotate world gravity into device coordinates, then classify its dominant axis.
    pub fn from_quat(q: &nalgebra::UnitQuaternion<f64>) -> Self {
        let gravity = q.inverse_transform_vector(&nalgebra::Vector3::new(0.0, 0.0, -1.0));
        Self::from_gravity(gravity.x, gravity.y, gravity.z)
    }

    /// Angles are radians: roll about X, then pitch about Y (R_y * R_x).
    /// A subsequent yaw about world Z does not change the gravity classification.
    pub fn from_pitch_roll(pitch: f32, roll: f32) -> Self {
        let (pitch, roll) = (pitch as f64, roll as f64);
        Self::from_gravity(
            Float::sin(pitch),
            -Float::sin(roll) * Float::cos(pitch),
            -Float::cos(roll) * Float::cos(pitch),
        )
    }

    /// Classify a device-frame gravity vector. Magnitude and units do not matter.
    /// Zero, non-finite vectors and dominant axes tied within one part per million
    /// return Unknown. This tolerance covers f32 angle rounding at boundaries.
    pub fn from_gravity(x: f64, y: f64, z: f64) -> Self {
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            return Self::Unknown;
        }
        let (ax, ay, az) = (x.abs(), y.abs(), z.abs());
        let max = ax.max(ay).max(az);
        let margin = max * 1e-6;
        if ax - ay.max(az) > margin {
            if x > 0.0 { Self::LeftUp } else { Self::RightUp }
        } else if ay - ax.max(az) > margin {
            if y > 0.0 { Self::TopDown } else { Self::TopUp }
        } else if az - ax.max(ay) > margin {
            if z > 0.0 {
                Self::FaceDown
            } else {
                Self::FaceUp
            }
        } else {
            Self::Unknown
        }
    }

    /// Integer device-frame gravity components, with the same signs as from_gravity.
    /// Convert support acceleration to gravity before calling this helper.
    pub fn from_accel(accel_x: isize, accel_y: isize, accel_z: isize) -> Self {
        Self::from_gravity(accel_x as f64, accel_y as f64, accel_z as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};
    use nalgebra::{UnitQuaternion, Vector3};

    #[test]
    fn six_principal_orientations_agree_across_inputs_and_yaw() {
        for (pitch, roll, gravity, expected) in [
            (0.0, 0.0, [0, 0, -1], Orientation::FaceUp),
            (0.0, PI, [0, 0, 1], Orientation::FaceDown),
            (0.0, FRAC_PI_2, [0, -1, 0], Orientation::TopUp),
            (0.0, -FRAC_PI_2, [0, 1, 0], Orientation::TopDown),
            (FRAC_PI_2, 0.0, [1, 0, 0], Orientation::LeftUp),
            (-FRAC_PI_2, 0.0, [-1, 0, 0], Orientation::RightUp),
            (PI, 0.0, [0, 0, 1], Orientation::FaceDown),
        ] {
            assert_eq!(
                Orientation::from_pitch_roll(pitch as f32, roll as f32),
                expected
            );
            assert_eq!(
                Orientation::from_accel(gravity[0], gravity[1], gravity[2]),
                expected
            );
            assert_eq!(
                Orientation::from_gravity(
                    gravity[0] as f64 * 9.81,
                    gravity[1] as f64 * 9.81,
                    gravity[2] as f64 * 9.81
                ),
                expected
            );
            for yaw in [0.0, 0.3, FRAC_PI_2, PI, -2.0] {
                let q = UnitQuaternion::from_euler_angles(roll, pitch, yaw);
                assert_eq!(Orientation::from_quat(&q), expected);
                assert_eq!(
                    Orientation::from_quat(&UnitQuaternion::new_unchecked(-q.into_inner())),
                    expected
                );
            }
        }
    }

    #[test]
    fn compound_rotations_use_the_same_gravity_classifier() {
        for pitch in [-2.7, -0.9, 0.0, 0.6, 2.3] {
            for roll in [-2.0, -0.5, 0.0, 0.8, 2.9] {
                let q = UnitQuaternion::from_euler_angles(roll, pitch, 1.7);
                let g = q.inverse_transform_vector(&Vector3::new(0.0, 0.0, -1.0));
                assert_eq!(
                    Orientation::from_quat(&q),
                    Orientation::from_gravity(g.x, g.y, g.z)
                );
                assert_eq!(
                    Orientation::from_quat(&q),
                    Orientation::from_pitch_roll(pitch as f32, roll as f32)
                );
            }
        }
    }

    #[test]
    fn ambiguous_and_invalid_inputs_are_unknown() {
        for (x, y, z) in [
            (0.0, 0.0, 0.0),
            (1.0, 1.0, 0.0),
            (1.0, 0.0, -1.0),
            (0.0, -1.0, -1.0),
            (1.0, 1.0, 1.0),
            (f64::NAN, 0.0, 1.0),
            (0.0, f64::INFINITY, 1.0),
        ] {
            assert_eq!(Orientation::from_gravity(x, y, z), Orientation::Unknown);
        }
        assert_eq!(Orientation::from_accel(0, 0, 0), Orientation::Unknown);
        assert_eq!(
            Orientation::from_accel(isize::MIN, 0, 0),
            Orientation::RightUp
        );
        for (pitch, roll) in [(FRAC_PI_4, 0.0), (0.0, FRAC_PI_4), (f64::NAN, 0.0)] {
            assert_eq!(
                Orientation::from_pitch_roll(pitch as f32, roll as f32),
                Orientation::Unknown
            );
            if pitch.is_finite() {
                assert_eq!(
                    Orientation::from_quat(&UnitQuaternion::from_euler_angles(roll, pitch, 0.0)),
                    Orientation::Unknown
                );
            }
        }
    }

    #[test]
    fn serialized_enum_values_are_unchanged() {
        for (value, orientation) in [
            Orientation::FaceUp,
            Orientation::FaceDown,
            Orientation::TopUp,
            Orientation::TopDown,
            Orientation::LeftUp,
            Orientation::RightUp,
            Orientation::Unknown,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                postcard::to_slice(&orientation, &mut [0; 1]).unwrap(),
                &[value as u8]
            );
        }
    }
}
