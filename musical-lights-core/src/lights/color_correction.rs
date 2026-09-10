//! Keep scene colors in linear sRGB. Apply the output response once, at the device.
use palette::{Hsluv, LinSrgb, Srgb};
use smart_leds::RGB8;

/// Standard HSLuv uses the D65 white point and 0–100 saturation/lightness.
pub fn convert_color(color: Hsluv) -> LinSrgb<f32> {
    // HSLuv reference D65 constants and matrices. Palette's rounded CIE D65
    // white point differs from HSLuv's reference and leaks light into primaries.
    // Public-domain math: https://www.hsluv.org/math/
    use num::Float;
    const M: [[f64; 3]; 3] = [
        [3.240969941904521, -1.537383177570093, -0.498610760293],
        [-0.96924363628087, 1.87596750150772, 0.041555057407175],
        [0.055630079696993, -0.20397695888897, 1.056971514242878],
    ];
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
    chroma *= f64::from(color.saturation).clamp(0.0, 100.0) / 100.0;
    let u = chroma * Float::cos(hue) / (13.0 * l) + 0.19783000664283;
    let v = chroma * Float::sin(hue) / (13.0 * l) + 0.46831999493879;
    let x = 9.0 * y * u / (4.0 * v);
    let z = y * (12.0 - 3.0 * u - 20.0 * v) / (4.0 * v);
    let rgb = M.map(|m| (m[0] * x + m[1] * y + m[2] * z).clamp(0.0, 1.0) as f32);
    LinSrgb::new(rgb[0], rgb[1], rgb[2])
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
