//! Keep scene colors in linear sRGB. Apply the output response once, at the device.
use palette::{Hsluv, LinSrgb, Srgb};
use smart_leds::RGB8;

const M: [[f64; 3]; 3] = [
    [3.240969941904521, -1.537383177570093, -0.498610760293],
    [-0.96924363628087, 1.87596750150772, 0.041555057407175],
    [0.055630079696993, -0.20397695888897, 1.056971514242878],
];

/// Standard HSLuv uses the D65 white point and 0–100 saturation/lightness.
pub fn convert_color(color: Hsluv) -> LinSrgb<f32> {
    // HSLuv reference D65 constants and matrices. Palette's rounded CIE D65
    // white point differs from HSLuv's reference and leaks light into primaries.
    // Public-domain math: https://www.hsluv.org/math/
    use num::Float;
    if ![color.hue.into_inner(), color.saturation, color.l]
        .iter()
        .all(|v| v.is_finite())
    {
        return LinSrgb::new(0.0, 0.0, 0.0);
    }
    let l = f64::from(color.l).clamp(0.0, 100.0);
    if l <= 1e-8 {
        return LinSrgb::new(0.0, 0.0, 0.0);
    }
    if l >= 99.9999999 {
        return LinSrgb::new(1.0, 1.0, 1.0);
    }
    let hue = f64::from(color.hue.into_inner()) * core::f64::consts::PI / 180.0;
    let sub1 = Float::powi((l + 16.0) / 116.0, 3);
    let y = if sub1 > 216.0 / 24389.0 {
        sub1
    } else {
        l / (24389.0 / 27.0)
    };
    let chroma = max_chroma(l, hue) * f64::from(color.saturation).clamp(0.0, 100.0) / 100.0;
    let u = chroma * Float::cos(hue) / (13.0 * l) + 0.19783000664283;
    let v = chroma * Float::sin(hue) / (13.0 * l) + 0.46831999493879;
    let x = 9.0 * y * u / (4.0 * v);
    let z = y * (12.0 - 3.0 * u - 20.0 * v) / (4.0 * v);
    let rgb = M.map(|m| (m[0] * x + m[1] * y + m[2] * z).clamp(0.0, 1.0) as f32);
    LinSrgb::new(rgb[0], rgb[1], rgb[2])
}

// Gamut boundary shared by forward and inverse reference-D65 conversions.
fn max_chroma(l: f64, hue: f64) -> f64 {
    use num::Float;
    let sub1 = Float::powi((l + 16.0) / 116.0, 3);
    let y = if sub1 > 216.0 / 24389.0 {
        sub1
    } else {
        l / (24389.0 / 27.0)
    };
    let mut chroma = f64::INFINITY;
    for [m1, m2, m3] in M {
        for t in [0.0, 1.0] {
            let top1 = (284517.0 * m1 - 94839.0 * m3) * y;
            let top2 = (838422.0 * m3 + 769860.0 * m2 + 731718.0 * m1) * l * y - 769860.0 * t * l;
            let bottom = (632260.0 * m3 - 126452.0 * m2) * y + 126452.0 * t;
            let length = (top2 / bottom) / (Float::sin(hue) - top1 / bottom * Float::cos(hue));
            if length >= 0.0 {
                chroma = chroma.min(length);
            }
        }
    }
    chroma
}

/// Inverse of `convert_color`, accepting linear (never screen-encoded) sRGB.
/// Achromatic colors use canonical hue zero. Invalid input is rejected.
pub fn linear_to_hsluv(rgb: [f32; 3]) -> Option<[f32; 3]> {
    use num::Float;
    if !rgb.iter().all(|v| (0.0..=1.0).contains(v)) {
        return None;
    }
    let [r, g, b] = rgb.map(f64::from);
    let x = 0.41239079926595 * r + 0.35758433938387 * g + 0.18048078840183 * b;
    let y = 0.21263900587151 * r + 0.71516867876775 * g + 0.072192315360733 * b;
    let z = 0.019330818715591 * r + 0.11919477979462 * g + 0.95053215224966 * b;
    let l = if y <= 216.0 / 24389.0 {
        y * (24389.0 / 27.0)
    } else {
        116.0 * Float::cbrt(y) - 16.0
    };
    if l < 1e-8 {
        return Some([0.0; 3]);
    }
    if l > 99.9999999 {
        return Some([0.0, 0.0, 100.0]);
    }
    let denominator = x + 15.0 * y + 3.0 * z;
    let u = 13.0 * l * (4.0 * x / denominator - 0.19783000664283);
    let v = 13.0 * l * (9.0 * y / denominator - 0.46831999493879);
    let chroma = Float::sqrt(u * u + v * v);
    if chroma < 1e-6 {
        return Some([0.0, 0.0, l as f32]);
    }
    let radians = Float::atan2(v, u);
    let hue = (radians.to_degrees() + 360.0) % 360.0;
    Some([
        hue as f32,
        (100.0 * chroma / max_chroma(l, radians)).clamp(0.0, 100.0) as f32,
        l as f32,
    ])
}

/// Shortest hue path; exact opposite hues travel toward increasing hue.
/// Borrow the chromatic hue at grey/black/white endpoints, or zero for two greys.
/// Saturation and lightness interpolate without overshoot. Hue is in degrees.
pub fn blend_hsluv(mut a: [f32; 3], mut b: [f32; 3], t: f32) -> Option<[f32; 3]> {
    if !(0.0..=1.0).contains(&t)
        || ![a, b].iter().all(|c| {
            c[0].is_finite() && (0.0..=100.0).contains(&c[1]) && (0.0..=100.0).contains(&c[2])
        })
    {
        return None;
    }
    let chromatic = |c: [f32; 3]| c[1] > 1e-4 && c[2] > 1e-5 && c[2] < 99.99999;
    match (chromatic(a), chromatic(b)) {
        (false, true) => a[0] = b[0],
        (true, false) => b[0] = a[0],
        (false, false) => {
            a[0] = 0.0;
            b[0] = 0.0;
        }
        _ => {}
    }
    let wrap = |h: f32| ((h % 360.0) + 360.0) % 360.0;
    let mut delta = wrap(wrap(b[0]) - wrap(a[0]));
    if delta > 180.0 {
        delta -= 360.0;
    }
    Some([
        wrap(wrap(a[0]) + delta * t),
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ])
}

/// HSLuv interpolation with linear-sRGB boundaries. Exact endpoints and equal
/// colors bypass conversion so spawn colors and untouched regions stay exact.
pub fn blend_linear_hsluv(a: [f32; 3], b: [f32; 3], t: f32) -> Option<[f32; 3]> {
    if !(0.0..=1.0).contains(&t) || !a.iter().chain(b.iter()).all(|v| (0.0..=1.0).contains(v)) {
        return None;
    }
    if t == 0.0 || a == b {
        return Some(a);
    }
    if t == 1.0 {
        return Some(b);
    }
    let hsl = blend_hsluv(linear_to_hsluv(a)?, linear_to_hsluv(b)?, t)?;
    let c = convert_color(Hsluv::new(hsl[0], hsl[1], hsl[2]));
    Some([c.red, c.green, c.blue])
}

/// Browser/CSS uses encoded sRGB. Do not apply an LED response to this result.
pub fn screen_color(color: LinSrgb<f32>) -> Srgb<f32> {
    Srgb::from_linear(color)
}

/// Measured inverse response: 17 drive values at equally spaced light outputs.
/// The identity default assumes linear PWM output; it is not a measured profile.
#[derive(Clone, Debug)]
pub struct LedResponse {
    inverse: [[f32; 17]; 3],
    white_balance: [f32; 3],
    measured: bool,
}

impl Default for LedResponse {
    fn default() -> Self {
        Self {
            inverse: [core::array::from_fn(|i| i as f32 / 16.0); 3],
            white_balance: [1.0; 3],
            measured: false,
        }
    }
}

impl LedResponse {
    pub fn measured(inverse: [[f32; 17]; 3], white_balance: [f32; 3]) -> Option<Self> {
        if !white_balance
            .iter()
            .all(|v| v.is_finite() && *v > 0.0 && *v <= 1.0)
            || !inverse.iter().all(|row| {
                row[0] == 0.0
                    && row[16] == 1.0
                    && row.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v))
                    && row.windows(2).all(|w| w[1] >= w[0])
            })
        {
            return None;
        }
        Some(Self {
            inverse,
            white_balance,
            measured: true,
        })
    }
    pub fn is_measured(&self) -> bool {
        self.measured
    }

    /// Linear light intent, inverse response, drive cap, then one quantization.
    pub fn encode(&self, color: LinSrgb<f32>, maximum_drive: u8) -> RGB8 {
        let components = [color.red, color.green, color.blue];
        let channels: [u8; 3] = core::array::from_fn(|i| {
            let light = (components[i] * self.white_balance[i]).clamp(0.0, 1.0);
            let position = light * 16.0;
            let lower = (position as usize).min(15);
            let drive = self.inverse[i][lower]
                + (position - lower as f32) * (self.inverse[i][lower + 1] - self.inverse[i][lower]);
            (drive * 255.0 + 0.5).min(maximum_drive as f32) as u8
        });
        RGB8::new(channels[0], channels[1], channels[2])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[allow(clippy::excessive_precision)] // Official snapshot values.
    fn inverse_matches_official_snapshot_and_round_trips_linear_rgb() {
        // snapshot-rev4.json: same selected vectors as validation/fixtures/hsluv-reference.json.
        let vectors: [([f32; 3], [f32; 3]); 12] = [
            ([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]),
            ([1.0, 1.0, 1.0], [0.0, 0.0, 100.0]),
            (
                [1.0, 0.0, 0.0],
                [12.177050630061776, 100.0000000000022, 53.23711559542933],
            ),
            (
                [0.0, 1.0, 0.0],
                [127.71501294924047, 100.00000000000222, 87.73551910965973],
            ),
            (
                [0.0, 0.0, 1.0],
                [265.8743202181779, 100.00000000000082, 32.30087290398002],
            ),
            (
                [
                    0.13286832155381798,
                    0.033104766570885055,
                    0.31854677812509186,
                ],
                [280.8444976170615, 70.76187693629068, 32.90280659427148],
            ),
            (
                [1.0, 1.0, 0.0],
                [85.87432021817473, 100.00000000007272, 97.13855934179674],
            ),
            (
                [0.0, 1.0, 1.0],
                [192.17705063006116, 99.99999999999149, 91.11475231670507],
            ),
            (
                [1.0, 0.0, 1.0],
                [307.7150129492436, 100.00000000000038, 60.322731354551294],
            ),
            (
                [0.184474994500441, 0.184474994500441, 0.184474994500441],
                [0.0, 1.9402040248474474e-12, 50.03443879253807],
            ),
            (
                [
                    0.005605391624202723,
                    0.01599629336550963,
                    0.033104766570885055,
                ],
                [244.93155638428982, 68.29655549894483, 12.621964857006773],
            ),
            (
                [0.8549926081242338, 0.4019777798321958, 0.05780543019106723],
                [49.61135327788833, 86.056132752536, 74.4105324975616],
            ),
        ];
        for (rgb, expected) in vectors {
            let actual = linear_to_hsluv(rgb).unwrap();
            for (a, b) in actual.into_iter().zip(expected) {
                assert!((a - b).abs() < 0.0001, "{actual:?} != {expected:?}");
            }
            let c = convert_color(Hsluv::new(actual[0], actual[1], actual[2]));
            for (a, b) in [c.red, c.green, c.blue].into_iter().zip(rgb) {
                assert!((a - b).abs() < 2e-6);
            }
        }
        for r in 0..=10 {
            for g in 0..=10 {
                for b in 0..=10 {
                    let rgb = [r, g, b].map(|v| v as f32 / 10.0);
                    let h = linear_to_hsluv(rgb).unwrap();
                    let c = convert_color(Hsluv::new(h[0], h[1], h[2]));
                    for (a, b) in [c.red, c.green, c.blue].into_iter().zip(rgb) {
                        assert!((a - b).abs() < 3e-6);
                    }
                }
            }
        }
    }

    #[test]
    fn hue_paths_achromatic_endpoints_and_invalid_values_are_explicit() {
        for (a, b, expected) in [
            (350.0, 10.0, 0.0),
            (10.0, 350.0, 0.0),
            (0.0, 180.0, 90.0),
            (180.0, 0.0, 270.0),
        ] {
            assert_eq!(
                blend_hsluv([a, 100.0, 58.0], [b, 100.0, 58.0], 0.5).unwrap(),
                [expected, 100.0, 58.0]
            );
        }
        for grey in [[80.0, 0.0, 50.0], [0.0, 0.0, 0.0], [0.0, 0.0, 100.0]] {
            for (a, b) in [(grey, [280.0, 100.0, 58.0]), ([280.0, 100.0, 58.0], grey)] {
                assert_eq!(blend_hsluv(a, b, 0.5).unwrap()[0], 280.0);
            }
        }
        assert_eq!(
            blend_hsluv([80.0, 0.0, 20.0], [270.0, 0.0, 80.0], 0.5),
            Some([0.0, 0.0, 50.0])
        );
        for bad in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
            assert!(linear_to_hsluv([bad, 0.0, 0.0]).is_none());
            assert!(blend_linear_hsluv([0.0; 3], [1.0; 3], bad).is_none());
        }
        assert!(blend_hsluv([f32::NAN, 100.0, 50.0], [0.0; 3], 0.5).is_none());
        assert!(blend_hsluv([0.0, 101.0, 50.0], [0.0; 3], 0.5).is_none());
    }

    #[test]
    fn complementary_blends_keep_saturation_and_exact_linear_endpoints() {
        let to_rgb = |h| {
            let c = convert_color(Hsluv::new(h, 100.0, 58.0));
            [c.red, c.green, c.blue]
        };
        for h in [0.0, 40.0, 100.0, 170.0] {
            let a = to_rgb(h);
            let b = to_rgb(h + 180.0);
            assert_eq!(blend_linear_hsluv(a, b, 0.0), Some(a));
            assert_eq!(blend_linear_hsluv(a, b, 1.0), Some(b));
            assert_eq!(blend_linear_hsluv(a, a, 0.5), Some(a));
            for step in 1..20 {
                let rgb = blend_linear_hsluv(a, b, step as f32 / 20.0).unwrap();
                let hsl = linear_to_hsluv(rgb).unwrap();
                assert!(hsl[1] > 99.99);
                assert!((hsl[2] - 58.0).abs() < 0.0001);
            }
        }
    }

    #[test]
    fn led_response_is_monotonic_and_only_applied_once() {
        let inverse = [core::array::from_fn(|i| num::Float::sqrt(i as f32 / 16.0)); 3];
        let response = LedResponse::measured(inverse, [1.0, 0.5, 1.0]).unwrap();
        // At 25% light, sqrt inverse gives 50% drive, not sqrt(sqrt(.25)).
        assert_eq!(response.encode(LinSrgb::new(0.25, 0.0, 0.0), 255).r, 128);
        let mut previous = RGB8::default();
        for i in 0..=1000 {
            let light = i as f32 / 1000.0;
            let rgb = response.encode(LinSrgb::new(light, light, light), 128);
            assert!(rgb.r >= previous.r && rgb.g >= previous.g && rgb.b >= previous.b);
            assert!(rgb.r <= 128 && rgb.g <= 128 && rgb.b <= 128);
            previous = rgb;
        }
        let mut invalid = [[0.0; 17]; 3];
        invalid[0][3] = f32::NAN;
        assert!(LedResponse::measured(invalid, [1.0; 3]).is_none());
    }
    #[test]
    fn screen_encoding_matches_srgb_transfer_function() {
        let color = screen_color(LinSrgb::new(0.0, 0.0031308, 0.18));
        assert_eq!(color.red, 0.0);
        assert!((color.green - 0.040449936).abs() < 1e-6);
        assert!((color.blue - 0.46135613).abs() < 1e-6);
    }

    #[test]
    #[allow(clippy::excessive_precision)] // Preserve the published reference values.
    fn matches_hsluv_reference_snapshot_rev4() {
        // https://github.com/hsluv/hsluv/blob/master/snapshots/snapshot-rev4.json
        let rgb = screen_color(convert_color(Hsluv::new(
            127.715012949240,
            100.000000000002,
            87.735519109660,
        ))); // #00ff00
        for (actual, expected) in [rgb.red, rgb.green, rgb.blue].into_iter().zip([
            0.000000000000,
            1.000000000000,
            0.000000000000,
        ]) {
            assert!((actual - expected).abs() < 0.0001, "{actual} != {expected}");
        }
        let rgb = screen_color(convert_color(Hsluv::new(
            12.177050630062,
            100.000000000002,
            53.237115595429,
        ))); // #ff0000
        for (actual, expected) in [rgb.red, rgb.green, rgb.blue].into_iter().zip([
            1.000000000000,
            0.000000000000,
            0.000000000000,
        ]) {
            assert!((actual - expected).abs() < 0.0001, "{actual} != {expected}");
        }
        let rgb = screen_color(convert_color(Hsluv::new(
            0.000000000000,
            0.000000000000,
            100.000000000000,
        ))); // #ffffff
        for (actual, expected) in [rgb.red, rgb.green, rgb.blue].into_iter().zip([
            1.000000000000,
            1.000000000000,
            1.000000000000,
        ]) {
            assert!((actual - expected).abs() < 0.0001, "{actual} != {expected}");
        }
        let rgb = screen_color(convert_color(Hsluv::new(
            0.000000000000,
            0.000000000000,
            0.000000000000,
        ))); // #000000
        for (actual, expected) in [rgb.red, rgb.green, rgb.blue].into_iter().zip([
            0.000000000000,
            0.000000000000,
            0.000000000000,
        ]) {
            assert!((actual - expected).abs() < 0.0001, "{actual} != {expected}");
        }
        let rgb = screen_color(convert_color(Hsluv::new(
            265.874320218178,
            100.000000000001,
            32.300872903980,
        ))); // #0000ff
        for (actual, expected) in [rgb.red, rgb.green, rgb.blue].into_iter().zip([
            0.000000000000,
            0.000000000000,
            1.000000000000,
        ]) {
            assert!((actual - expected).abs() < 0.0001, "{actual} != {expected}");
        }
    }
}
