//! Calibrated body-frame heading with independent sample ages and recovery.
use crate::{
    message::{Heading, L2},
    provisioning::Coefficients,
    sensor_mount::{ImuMounts, SensorSamples},
};
use ahrs::{Ahrs, Madgwick};
use nalgebra::{Matrix3, Vector3};
use num::Float;
#[derive(Clone, Copy, Debug)]
pub struct ImuSample {
    pub accel: [f64; 3],
    pub gyro: [f64; 3],
    pub mag: [f64; 3],
    pub accel_at: u64,
    pub gyro_at: u64,
    pub mag_at: u64,
    pub saturated: bool,
}
pub struct HeadingEstimator {
    fusion: Madgwick<f64>,
    last_at: Option<u64>,
    recover_at: Option<u64>,
    dynamic_at: Option<u64>,
    ready: bool,
}
impl Default for HeadingEstimator {
    fn default() -> Self {
        Self {
            fusion: Madgwick::new(0.01, 0.1),
            last_at: None,
            recover_at: None,
            dynamic_at: None,
            ready: false,
        }
    }
}
impl HeadingEstimator {
    pub fn update(
        &mut self,
        sample: ImuSample,
        calibration: Option<&Coefficients>,
        mounts: ImuMounts,
        declination: Option<f32>,
        now: u64,
    ) -> Heading {
        let oldest = sample.accel_at.min(sample.gyro_at).min(sample.mag_at);
        let mut output = Heading {
            age: L2::new(now.saturating_sub(oldest).min(u16::MAX as u64) as u16),
            ..Heading::default()
        };
        let missing = now.saturating_sub(sample.accel_at) > 50
            || now.saturating_sub(sample.gyro_at) > 50
            || now.saturating_sub(sample.mag_at) > 200
            || sample.saturated
            || !sample
                .accel
                .iter()
                .chain(&sample.gyro)
                .chain(&sample.mag)
                .all(|v| v.is_finite());
        if missing {
            self.recover_at = None;
            self.ready = false;
            output.faults = L2::new(
                1 | if sample.saturated
                    || !sample
                        .accel
                        .iter()
                        .chain(&sample.gyro)
                        .chain(&sample.mag)
                        .all(|v| v.is_finite())
                {
                    64
                } else {
                    0
                },
            );
            return output;
        }
        let Some(c) = calibration else {
            self.recover_at = None;
            self.ready = false;
            output.quality = 1;
            output.faults = L2::new(2);
            return output;
        };
        output.calibration_revision = c.revision;
        let accel = Vector3::from(core::array::from_fn(|i| {
            (sample.accel[i] - c.accel_bias[i].get() as f64) * c.accel_scale[i].get() as f64
        }));
        let gyro = Vector3::from(core::array::from_fn(|i| {
            sample.gyro[i] - c.gyro_bias[i].get() as f64
        }));
        let raw_mag = Vector3::from(core::array::from_fn(|i| {
            sample.mag[i] - c.mag_bias[i].get() as f64
        }));
        let matrix = Matrix3::from_row_slice(&c.mag_matrix.map(|v| v.get() as f64));
        let body = mounts.to_body(SensorSamples {
            accelerometer: accel,
            gyro: Some(gyro),
            magnetometer: Some(matrix * raw_mag),
        });
        let gyro = body.gyro.unwrap();
        let mag = body.magnetometer.unwrap();
        let accel = body.accelerometer;
        let acceleration = accel.norm() / 9.80665;
        let magnitude = mag.norm();
        if acceleration <= 0.0 || magnitude <= 0.0 {
            self.recover_at = None;
            self.ready = false;
            output.faults = L2::new(1);
            return output;
        }
        if let Some(last) = self.last_at {
            *self.fusion.sample_period_mut() =
                (now.saturating_sub(last) as f64 / 1000.0).clamp(0.001, 0.05);
        }
        self.last_at = Some(now);
        // Fusion retains its quaternion between measured sample intervals.
        let up = match self.fusion.update(&gyro, &accel, &mag) {
            Ok(q) => q.inverse_transform_vector(&Vector3::new(0.0, 0.0, 1.0)),
            Err(_) => {
                self.recover_at = None;
                self.ready = false;
                output.faults = L2::new(1);
                return output;
            }
        };
        let north = mag - up * mag.dot(&up);
        let observed_up = accel / accel.norm();
        let horizontal = (mag - observed_up * mag.dot(&observed_up)).norm();
        let tilt = Float::acos(observed_up.z.clamp(-1.0, 1.0)).to_degrees();
        let top = Float::sqrt((1.0 - observed_up.y * observed_up.y).max(0.0));
        let field_error = (magnitude / c.field.get() as f64 - 1.0).abs();
        let disturbed =
            !(15.0..=80.0).contains(&magnitude) || field_error > 0.20 || horizontal < 10.0;
        let tilted = tilt > 60.0 || top < 0.5;
        if !(0.85..=1.15).contains(&acceleration) {
            self.dynamic_at.get_or_insert(now);
        } else {
            self.dynamic_at = None;
        }
        let dynamic = self
            .dynamic_at
            .is_some_and(|at| now.saturating_sub(at) >= 200);
        let recovering = field_error <= 0.15
            && horizontal >= 12.0
            && tilt <= 50.0
            && top >= 0.6
            && (0.90..=1.10).contains(&acceleration);
        if !recovering {
            self.recover_at = None;
        } else {
            self.recover_at.get_or_insert(now);
        }
        if disturbed || tilted || dynamic {
            self.ready = false;
        }
        if self
            .recover_at
            .is_some_and(|at| now.saturating_sub(at) >= 2000)
        {
            self.ready = true;
        }
        output.tilt = L2::new(Float::round(tilt * 100.0).clamp(0.0, 9000.0) as u16);
        output.faults = L2::new(
            (if !(15.0..=80.0).contains(&magnitude) || field_error > 0.20 {
                4
            } else {
                0
            }) | (if horizontal < 10.0 { 8 } else { 0 })
                | (if tilted { 16 } else { 0 })
                | (if dynamic { 32 } else { 0 }),
        );
        output.quality = if disturbed {
            5
        } else if tilted {
            6
        } else if dynamic {
            7
        } else if !self.ready {
            2
        } else if declination.is_some() {
            4
        } else {
            3
        };
        if matches!(output.quality, 3 | 4) {
            let magnetic = wrap(Float::atan2(-north.x, north.y).to_degrees());
            output.magnetic = L2::new((Float::round(magnetic * 100.0) as u16) % 36000);
            if let Some(d) = declination {
                output.true_north =
                    L2::new((Float::round(wrap(magnetic + d as f64) * 100.0) as u16) % 36000);
            }
        }
        output
    }
}
pub fn wrap(value: f64) -> f64 {
    num::traits::Euclid::rem_euclid(&value, &360.0)
}
pub fn declination(fix: crate::gps::Fix) -> Option<f32> {
    use world_magnetic_model::{
        GeomagneticField,
        time::OffsetDateTime,
        uom::si::{
            angle::degree,
            f32::{Angle, Length},
            length::meter,
        },
    };
    if !fix.valid {
        return None;
    }
    let date = OffsetDateTime::from_unix_timestamp((fix.utc_ms / 1000) as i64)
        .ok()?
        .date();
    if !(2025..=2029).contains(&date.year()) {
        return None;
    }
    let field = GeomagneticField::new(
        Length::new::<meter>(fix.altitude_m?),
        Angle::new::<degree>(fix.latitude_e7 as f32 / 1e7),
        Angle::new::<degree>(fix.longitude_e7 as f32 / 1e7),
        date,
    )
    .ok()?;
    Some(field.declination().get::<degree>())
}
