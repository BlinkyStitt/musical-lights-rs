# Sensor mounting

`musical_lights_core::sensor_mount` converts sensor coordinates into the
existing right-handed body frame: X right, Y toward the top edge, Z out of
the display. World gravity points along -Z.

`SensorMount::from_axes([x, y, z])` takes the body directions of the sensor's
positive X, Y and Z axes. For example, `[SignedAxis::Y, SignedAxis::NegX,
SignedAxis::Z]` maps sensor +X to body +Y, and sensor +Y to body -X.
The constructor accepts the 24 proper signed-axis rotations. It rejects
repeated axes and reflections.

`SensorMount::from_quaternion(q_bs)` accepts a finite, nonzero quaternion and
normalizes it. `nalgebra::Quaternion::new(w, x, y, z)` uses scalar-first order.
The mount stores one unit quaternion. `to_body` and `to_sensor` convert vectors;
`inverse` returns the reverse transform.

If `q_ws` maps sensor coordinates into world coordinates, `body_attitude(q_ws)`
returns `q_wb = q_ws * inverse(q_bs)`. The multiplication order matters.
This conversion preserves the existing `Orientation` values and wire fields.

`ImuMounts` has independent `accelerometer`, `gyro` and `magnetometer` mounts.
Pass calibrated `SensorSamples` to `to_body` once. It returns `BodySamples`.
Gyro and magnetometer samples can be absent. Acceleration uses m/s², gyro
uses rad/s, and magnetometer uses µT. Rotation preserves those units.
Accelerometers measure support acceleration; convert it to gravity when the
orientation classifier requires gravity.

Apply bias, scale and magnetic calibration in each sensor's native frame before
rotation. Then pass body samples to the existing fusion or classification
code. This API performs no calibration or fusion, and does not select a board's
mounting axes. Physical mounting and attitude checks remain board acceptance work.
