use num::Float;
use postcard::experimental::max_size::MaxSize;
use serde::{Deserialize, Serialize};

/// Mean Earth radius in meters, retained for the spherical course model.
pub const EARTH_RADIUS: f32 = 6371000.0;

#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Deserialize, Serialize, Debug, PartialEq, MaxSize)]
pub struct Course {
    /// Great-circle distance in meters.
    pub distance: f32,
    /// Initial bearing in degrees clockwise from north, in [0, 360).
    /// Magnetic declination is added to the true bearing.
    pub magnetic_bearing: f32,
}

#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Copy, Clone, Default, Deserialize, Serialize, Debug, PartialEq, MaxSize)]
pub struct Coordinate {
    /// Latitude in degrees, positive north.
    pub lat: f32,
    /// Longitude in degrees, positive east.
    pub lon: f32,
}

#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Copy, Clone, Default, Deserialize, Serialize, Debug, PartialEq, MaxSize)]
pub struct Magnetometer {
    pub x_gauss: f32,
    pub y_gauss: f32,
    pub z_gauss: f32,
}

impl Course {
    /// Calculate a spherical course from degree coordinates and declination.
    ///
    /// The established entry point uses f64 haversine arithmetic to retain
    /// short-distance precision. Results and serialized fields remain f32.
    /// Declination is in degrees and is additive; positive values turn clockwise.
    /// Identical points have no direction and return the wrapped declination.
    pub fn spherical_law_of_cosines(
        from: Coordinate,
        to: Coordinate,
        magnetic_declination: f32,
    ) -> Self {
        let lat1 = (from.lat as f64).to_radians();
        let lat2 = (to.lat as f64).to_radians();
        let delta_lat = ((to.lat as f64) - (from.lat as f64)).to_radians();
        let delta_lon = ((to.lon as f64) - (from.lon as f64)).to_radians();
        let sin_lat = Float::sin(delta_lat / 2.0);
        let sin_lon = Float::sin(delta_lon / 2.0);
        let a = (sin_lat * sin_lat + Float::cos(lat1) * Float::cos(lat2) * sin_lon * sin_lon)
            .clamp(0.0, 1.0);
        let distance =
            2.0 * Float::atan2(Float::sqrt(a), Float::sqrt(1.0 - a)) * EARTH_RADIUS as f64;

        let y = Float::sin(delta_lon) * Float::cos(lat2);
        let x = Float::cos(lat1) * Float::sin(lat2)
            - Float::sin(lat1) * Float::cos(lat2) * Float::cos(delta_lon);
        let angle = Float::atan2(y, x).to_degrees() + magnetic_declination as f64;
        let bearing = num::traits::Euclid::rem_euclid(&angle, &360.0) as f32;
        Self {
            distance: distance as f32,
            // Rounding to f32 can turn a value just below 360 into 360.
            magnetic_bearing: bearing % 360.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinate(lat: f32, lon: f32) -> Coordinate {
        Coordinate { lat, lon }
    }
    fn course(from: Coordinate, to: Coordinate) -> Course {
        Course::spherical_law_of_cosines(from, to, 0.0)
    }
    fn near(actual: f32, expected: f64, tolerance: f64) {
        assert!(
            (actual as f64 - expected).abs() <= tolerance,
            "{actual} != {expected}"
        );
    }

    #[test]
    fn cardinal_diagonal_and_non_equatorial_bearings() {
        let origin = coordinate(0.0, 0.0);
        for (lat, lon, expected) in [
            (1.0, 0.0, 0.0),
            (0.0, 1.0, 90.0),
            (-1.0, 0.0, 180.0),
            (0.0, -1.0, 270.0),
            (1.0, 1.0, 45.0),
            (-1.0, 1.0, 135.0),
            (-1.0, -1.0, 225.0),
            (1.0, -1.0, 315.0),
        ] {
            near(
                course(origin, coordinate(lat, lon)).magnetic_bearing,
                expected,
                0.01,
            );
        }
        near(
            course(coordinate(45.0, 0.0), coordinate(45.0, 90.0)).magnetic_bearing,
            54.7356103,
            0.0001,
        );
        near(
            course(coordinate(-45.0, 0.0), coordinate(-45.0, 90.0)).magnetic_bearing,
            125.2643897,
            0.0001,
        );
    }

    #[test]
    fn additive_declination_wraps_in_both_directions() {
        for (declination, expected) in [
            (0.0, 90.0),
            (15.0, 105.0),
            (-100.0, 350.0),
            (720.0, 90.0),
            (-810.0, 0.0),
        ] {
            near(
                Course::spherical_law_of_cosines(
                    coordinate(0.0, 0.0),
                    coordinate(0.0, 1.0),
                    declination,
                )
                .magnetic_bearing,
                expected,
                0.0001,
            );
        }
    }

    #[test]
    fn analytic_distances_and_nearby_coordinate_precision() {
        let radius = EARTH_RADIUS as f64;
        for (from, to, expected, tolerance) in [
            (coordinate(37.0, -122.0), coordinate(37.0, -122.0), 0.0, 0.0),
            (
                coordinate(0.0, 0.0),
                coordinate(1.0, 0.0),
                radius.to_radians(),
                0.01,
            ),
            (
                coordinate(0.0, 0.0),
                coordinate(0.0, 90.0),
                radius * core::f64::consts::FRAC_PI_2,
                1.0,
            ),
            (
                coordinate(0.0, 0.0),
                coordinate(0.0, 180.0),
                radius * core::f64::consts::PI,
                2.0,
            ),
            (
                coordinate(0.0, 179.0),
                coordinate(0.0, -179.0),
                (2.0 * radius).to_radians(),
                0.02,
            ),
            (
                coordinate(90.0, 0.0),
                coordinate(-90.0, 0.0),
                radius * core::f64::consts::PI,
                2.0,
            ),
            (
                coordinate(90.0, 0.0),
                coordinate(90.0, 120.0),
                0.0,
                0.000001,
            ),
            (
                coordinate(37.0, -122.0),
                coordinate(37.0001, -122.0),
                11.029,
                0.001,
            ),
        ] {
            near(course(from, to).distance, expected, tolerance);
            near(course(to, from).distance, expected, tolerance);
        }
        assert_eq!(
            course(coordinate(37.0, -122.0), coordinate(37.0, -122.0)).magnetic_bearing,
            0.0
        );
        near(
            course(coordinate(0.0, 179.0), coordinate(0.0, -179.0)).magnetic_bearing,
            90.0,
            0.0001,
        );
        near(
            course(coordinate(89.0, 10.0), coordinate(90.0, 10.0)).magnetic_bearing,
            0.0,
            0.0001,
        );
    }

    // Independent central angle from the cross and dot products of unit vectors.
    fn reference_distance(from: Coordinate, to: Coordinate) -> f64 {
        let vector = |c: Coordinate| {
            let (lat, lon) = ((c.lat as f64).to_radians(), (c.lon as f64).to_radians());
            [lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin()]
        };
        let (a, b) = (vector(from), vector(to));
        let cross = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
        let sine = cross.iter().map(|v| v * v).sum::<f64>().sqrt();
        let cosine = a.iter().zip(b).map(|(x, y)| x * y).sum::<f64>();
        sine.atan2(cosine) * EARTH_RADIUS as f64
    }

    #[test]
    fn distances_match_independent_unit_vector_reference() {
        let points = [
            coordinate(0.0, 0.0),
            coordinate(37.0, -122.0),
            coordinate(37.0001, -122.0),
            coordinate(-33.86, 151.21),
            coordinate(89.999, 179.999),
            coordinate(-89.999, -179.999),
            coordinate(90.0, 0.0),
            coordinate(-90.0, 120.0),
            coordinate(0.0, 179.999),
            coordinate(0.0, -179.999),
            coordinate(0.0, 180.0),
        ];
        for from in points {
            for to in points {
                let expected = reference_distance(from, to);
                // Allow final f32 rounding (about 1 meter at an Earth diameter).
                near(
                    course(from, to).distance,
                    expected,
                    0.0001 + expected * 1e-7,
                );
            }
        }
    }
}
