//! TODO: `brightness_video` and `gamma_video` that doesn't dim lower than 1

use crate::logging::warn;
use palette::{Hsluv, IsWithinBounds, LinSrgb, chromatic_adaptation::AdaptInto, white_point};

/// TODO: generic input color (and whitepoint)
/// TODO: linear srgb or no? i have no idea what i am doing
pub fn convert_color(color: Hsluv<white_point::E, f32>) -> (u8, u8, u8) {
    // TODO: this used to have a debug format, but it was removed
    // info!("hsluv color: {:?}", color);

    let rgb: LinSrgb<f32> = color.adapt_into();

    let rgb: LinSrgb<u8> = rgb.into_format();

    // TODO: this used to have a debug format, but it was removed
    // info!("linsrgb: {:?}", rgb);

    if !rgb.is_within_bounds() {
        // warn!("rgb is out of bounds! {:?}", rgb);
        warn!("rgb is out of bounds!");
    }

    // // TODO: how to debug log the hue?
    // debug!(
    //     "{} {} {} -> {} {} {}",
    //     color.hue.0, color.saturation, color.l, rgb.red, rgb.green, rgb.blue,
    // );

    rgb.into_components()
}

#[cfg(test)]
mod tests {
    use palette::{Hsluv, IntoColor, IsWithinBounds, Lch, Srgb};

    #[test]
    fn test_lch_to_srgb_f32() {
        let rgb: Srgb = Lch::new(50.0, 100.0, -175.0).into_color();
        assert!(rgb.is_within_bounds());
    }

    #[test]
    fn test_hsluv_to_srgb_f32() {
        let rgb: Srgb<f32> = Hsluv::new(50.0, 100.0, -175.0).into_color();
        assert!(rgb.is_within_bounds());

        let rgb: Srgb<u8> = rgb.into_format();
        assert!(rgb.is_within_bounds());
    }
}
