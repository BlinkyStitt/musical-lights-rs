// declination calculator for magnetic bearing
// TODO: why does the linter think this is unused when math functions on f32 are used. something about std being enabled in the linter?
#[allow(unused_imports)]
use micromath::F32Ext;
use postcard::experimental::max_size::MaxSize;
use serde::{Deserialize, Serialize};

// /// Degrees to Radians
// const DEG2RAD: f32 = 0.017453292;
// const RAD2DEG: f32 = 1.0 / DEG2RAD;

/// in meters
pub const EARTH_RADIUS: f32 = 6371000.0;

/// we don't have std, so we don't have PI
/// TODO: use std if we do have it?
#[allow(clippy::approx_constant)]
const PI: f32 = 3.141_592_7;

#[derive(Deserialize, Serialize, Debug, PartialEq, MaxSize, defmt::Format)]
pub struct Course {
    /// in meters
    pub distance: f32,
    /// Positive angles measured counter-clockwise
    /// from positive x axis
    /// -pi/4 radians (45 deg clockwise)
    pub magnetic_bearing: f32,
}

// TODO: should these be in the Gps Module instead?
#[derive(Deserialize, Serialize, Debug, PartialEq, MaxSize, defmt::Format)]
pub struct Coordinate {
    /// latitude
    pub lat: f32,
    /// longitude
    pub lon: f32,
}

#[derive(Deserialize, Serialize, Debug, PartialEq, MaxSize, defmt::Format)]
pub struct Magnetometer {
    pub x_gauss: f32,
    pub y_gauss: f32,
    pub z_gauss: f32,
}

impl Course {
    fn magnetic_bearing(from: Coordinate, to: Coordinate, magnetic_declination: f32) -> f32 {
        /*
        φ is latitude, λ is longitude, R is earth’s radius (mean radius = 6,371km);
        note that angles need to be in radians to pass to trig functions!

        Formula: 	θ = atan2( sin Δλ ⋅ cos φ2 , cos φ1 ⋅ sin φ2 − sin φ1 ⋅ cos φ2 ⋅ cos Δλ )
            where 	φ1,λ1 is the start point, φ2,λ2 the end point (Δλ is the difference in longitude)

        JavaScript: (all angles in radians)

        const y = Math.sin(λ2-λ1) * Math.cos(φ2);
        const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
        const θ = Math.atan2(y, x);
        const bearing = (θ*180/Math.PI + 360) % 360; // in degrees
        */
        let y = (to.lon - from.lon).sin() * to.lat.cos();
        let x = from.lat.cos() * to.lat.sin() - from.lat.sin() * to.lat.cos() * (to.lon - from.lon);
        let θ = y.atan2(x);

        // bearing in degrees
        // atan2 returns values in the range -π ... +π (that is, -180° ... +180°)
        (θ * 180.0 / PI + magnetic_declination + 360.0) % 360.0
    }

    /*
    pub fn haversine(from: Coordinate, to: Coordinate, magnetic_declination: f32) -> Self {
        /*
        φ is latitude, λ is longitude, R is earth’s radius (mean radius = 6,371km);
        note that angles need to be in radians to pass to trig functions!

        Haversine
        formula: 	a = sin²(Δφ/2) + cos φ1 ⋅ cos φ2 ⋅ sin²(Δλ/2)
                    c = 2 ⋅ atan2( √a, √(1−a) )
                    d = R ⋅ c

        In javascript:

            const R = 6371e3; // metres
            const φ1 = lat1 * Math.PI/180; // φ, λ in radians
            const φ2 = lat2 * Math.PI/180;
            const Δφ = (lat2-lat1) * Math.PI/180;
            const Δλ = (lon2-lon1) * Math.PI/180;

            const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

            const d = R * c; // in metres
        */

        let magnetic_bearing = Self::magnetic_bearing(from, to, magnetic_declination);

        let distance = todo!();

        Self {
            distance,
            magnetic_bearing,
        }
    }
    */

    #[allow(non_snake_case)]
    pub fn spherical_law_of_cosines(
        from: Coordinate,
        to: Coordinate,
        magnetic_declination: f32,
    ) -> Self {
        /*
           φ is latitude, λ is longitude, R is earth’s radius (mean radius = 6,371km);
           note that angles need to be in radians to pass to trig functions!

           Law of cosines: 	d = acos( sin φ1 ⋅ sin φ2 + cos φ1 ⋅ cos φ2 ⋅ cos Δλ ) ⋅ R
           JavaScript:

           const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180, Δλ = (lon2-lon1) * Math.PI/180, R = 6371e3;
           const d = Math.acos( Math.sin(φ1)*Math.sin(φ2) + Math.cos(φ1)*Math.cos(φ2) * Math.cos(Δλ) ) * R;
        */
        let φ1 = from.lat * PI / 180.0;
        let φ2 = to.lat * PI / 180.0;
        let Δλ = (to.lon - from.lon) * PI / 180.0;

        let distance = (φ1.sin() * φ2.sin() + φ1.cos() * φ2.cos() * Δλ.cos()).acos() * EARTH_RADIUS;

        let magnetic_bearing = Self::magnetic_bearing(from, to, magnetic_declination);

        Course {
            distance,
            magnetic_bearing,
        }
    }

    /*
    pub fn polar_coordinate_flat_earth(
        from: Coordinate,
        to: Coordinate,
        magnetic_declination: f32,
    ) -> Self {
        /*
            the polar coordinate flat-earth formula can be used:
            using the co-latitudes θ1 = π/2−φ1 and θ2 = π/2−φ2,
            then d = R ⋅ sqrt(θ1² + θ2² − 2 ⋅ θ1 ⋅ θ2 ⋅ cos Δλ). I’ve not compared accuracy.
        */
        todo!();
    }
    */

    /*
    /// If performance is an issue and accuracy less important, for small distances Pythagoras’ theorem
    /// can be used on an equi­rectangular projec­tion:
    /// TODO: something is wrong with this
    pub fn equirectangular(from: Coordinate, to: Coordinate, magnetic_declination: f32) -> Self {
        /*
            φ is latitude, λ is longitude, R is earth’s radius (mean radius = 6,371km);
            note that angles need to be in radians to pass to trig functions!

            Formula 	x = Δλ ⋅ cos φm
                        y = Δφ
                        d = R ⋅ √x² + y²

            JavaScript:

                const x = (λ2-λ1) * Math.cos((φ1+φ2)/2);
                const y = (φ2-φ1);
                const d = Math.sqrt(x*x + y*y) * R;
        */
        let x = (to.lon - from.lon) * ((from.lat + to.lat) / 2.0).cos();
        let y = to.lat - from.lat;
        let distance = (x * x + y * y).sqrt() * EARTH_RADIUS;

        // dbg!(x);
        // dbg!(y);
        // dbg!(distance);

        let magnetic_bearing = Self::magnetic_bearing(from, to, magnetic_declination);

        // dbg!(magnetic_bearing);

        Self {
            distance,
            magnetic_bearing,
        }
    }
    */
}

// /// TODO: i don't actually like this. deprecate this
// impl From<(Coordinate, Coordinate, f32)> for Course {
//     fn from((from, to, magnetic_declination): (Coordinate, Coordinate, f32)) -> Self {
//         Self::spherical_law_of_cosines(from, to, magnetic_declination)
//     }
// }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spherical_law_of_cosines() {
        let c1 = Coordinate { lat: 0.0, lon: 0.0 };
        let c2 = Coordinate { lat: 1.0, lon: 0.0 };

        let course = Course::spherical_law_of_cosines(c1, c2, 0.0);

        let expected_distance = 111189.45;
        assert_eq!(course.magnetic_bearing, 0.0);
        assert_eq!(course.distance, expected_distance);
    }
}
