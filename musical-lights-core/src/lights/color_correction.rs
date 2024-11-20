//! TODO: `brightness_video` and `gamma_video` that doesn't dim lower than 1

use crate::logging::warn;
use core::{iter::Take, marker::PhantomData};
use palette::{chromatic_adaptation::AdaptInto, white_point, Hsluv, IsWithinBounds, LinSrgb};
use smart_leds::{brightness as brightness_iter, gamma, Brightness, Gamma, RGB8};

pub mod color_order {
    pub struct RGB;
    pub struct GRB;
}

pub struct ColorCorrection<ColorOrder, I> {
    // // TODO: dynamic gamma. currently static of 2.8
    // pub gamma: f32,
    iter: Take<Brightness<Gamma<I>>>,
    marker: PhantomData<ColorOrder>,
}

pub fn color_correction<ColorOrder, I>(
    iter: I,
    brightness: u8,
    num: usize,
) -> ColorCorrection<ColorOrder, I>
where
    I: Iterator<Item = RGB8>,
{
    let iter = brightness_iter(gamma(iter), brightness).take(num);

    ColorCorrection::<ColorOrder, I> {
        iter,
        marker: PhantomData,
    }
}

impl<I> Iterator for ColorCorrection<color_order::RGB, I>
where
    I: Iterator<Item = RGB8>,
{
    type Item = RGB8;

    #[inline(always)]
    fn next(&mut self) -> Option<RGB8> {
        self.iter.next()
    }
}

impl<I> Iterator for ColorCorrection<color_order::GRB, I>
where
    I: Iterator<Item = RGB8>,
{
    type Item = RGB8;

    /// <https://github.com/smart-leds-rs/ws2812-spi-rs/issues/7>
    fn next(&mut self) -> Option<RGB8> {
        self.iter.next().map(|a| RGB8 {
            r: a.g,
            g: a.r,
            b: a.b,
        })
    }
}

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
