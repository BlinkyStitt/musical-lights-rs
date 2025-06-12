/// TODO: better names?
/// Imagine holding a phone in front of you and the names here should all make sense
use postcard::experimental::max_size::MaxSize;
use serde::{Deserialize, Serialize};

/// TODO: defmt should be optional!
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Copy, Clone, Debug, Serialize, Deserialize, MaxSize, PartialEq)]
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
    Unknown,
}

impl Orientation {
    /// TODO: this is untested code from chat gpt.
    pub fn from_quat(q: &nalgebra::UnitQuaternion<f64>) -> Self {
        // Gravity vector in world frame (downward)
        let world_down = nalgebra::Vector3::new(0.0, 0.0, -1.0);
        // Rotate into the device frame
        let device_gravity = q.inverse().transform_vector(&world_down);

        let [x, y, z] = [device_gravity.x, device_gravity.y, device_gravity.z];

        let mut max = z.abs();
        let mut orientation = if z > 0.0 {
            Orientation::FaceUp
        } else {
            Orientation::FaceDown
        };

        if x.abs() > max {
            max = x.abs();
            orientation = if x > 0.0 {
                Orientation::RightUp
            } else {
                Orientation::LeftUp
            };
        }

        if y.abs() > max {
            orientation = if y > 0.0 {
                Orientation::TopDown
            } else {
                Orientation::TopUp
            };
        }

        orientation
    }

    /// TODO: this is untested code from chat gpt.
    pub fn from_pitch_roll(pitch: f32, roll: f32) -> Self {
        let pitch = pitch.to_degrees();
        let roll = roll.to_degrees();

        match (pitch, roll) {
            (p, r) if p.abs() < 45.0 && r.abs() < 45.0 => Orientation::FaceUp,
            (p, r) if p.abs() > 135.0 && r.abs() < 45.0 => Orientation::FaceDown,
            (p, r) if p > 45.0 && p < 135.0 && r.abs() < 45.0 => Orientation::TopUp,
            (p, r) if p < -45.0 && p > -135.0 && r.abs() < 45.0 => Orientation::TopDown,
            (p, r) if r > 45.0 && r < 135.0 && p.abs() < 45.0 => Orientation::RightUp,
            (p, r) if r < -45.0 && r > -135.0 && p.abs() < 45.0 => Orientation::LeftUp,
            _ => Orientation::Unknown,
        }
    }

    /// acceleration is the absolute value.
    /// TODO: these orientations might be backwards. check them
    pub fn from_accel(accel_x: isize, accel_y: isize, accel_z: isize) -> Self {
        let abs_x = accel_x.abs();
        let abs_y = accel_y.abs();
        let abs_z = accel_z.abs();

        if (abs_z > abs_x) && (abs_z > abs_y) {
            // base orientation on Z
            if accel_z > 0 {
                return Self::FaceDown;
            }
            return Self::FaceUp;
        }

        if (abs_y > abs_x) && (abs_y > abs_z) {
            // base orientation on Y
            if accel_y > 0 {
                return Self::LeftUp;
            }
            return Self::RightUp;
        }

        // base orientation on X
        if accel_x < 0 {
            return Self::TopDown;
        }

        Self::TopUp
    }
}
