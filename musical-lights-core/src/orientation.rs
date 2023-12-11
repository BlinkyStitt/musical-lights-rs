/// TODO: better names?
/// Imagine holding a phone in front of you and the names here should all make sense
pub enum Orientation {
    Up,
    Down,
    /// in old code this was "ORIENTED_USB_DOWN"
    LandscapeLeft,
    /// in old code this was "ORIENTED_USB_UP"
    LandscapeRight,
    PortraitUp,
    PortraitUpsideDown,
}

/// acceleration is the absolute value.
/// TODO: landscape left and right might be backwards
pub fn current_orientation(accel_x: isize, accel_y: isize, accel_z: isize) -> Orientation {
    let abs_x = accel_x.abs();
    let abs_y = accel_y.abs();
    let abs_z = accel_z.abs();

    if (abs_z > abs_x) && (abs_z > abs_y) {
        // base orientation on Z
        if accel_z > 0 {
            return Orientation::Down;
        }
        return Orientation::Up;
    }

    if (abs_y > abs_x) && (abs_y > abs_z) {
        // base orientation on Y
        if accel_y > 0 {
            return Orientation::LandscapeLeft;
        }
        return Orientation::LandscapeRight;
    }

    // base orientation on X
    if accel_x < 0 {
        return Orientation::PortraitUpsideDown;
    }

    Orientation::PortraitUp
}
