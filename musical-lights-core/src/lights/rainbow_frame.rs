use smart_leds::{
    RGB8,
    hsv::{Hsv, hsv2rgb},
};

/// Fill each pair of pixels with the next hue, preserving saturation and value.
pub fn fill_rainbow_frame(frame: &mut [RGB8], base: Hsv) {
    for (i, pixel) in frame.iter_mut().enumerate() {
        let mut color = base;
        color.hue = color.hue.wrapping_add((i / 2) as u8);
        *pixel = hsv2rgb(color);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fills_every_pixel_and_wraps_hue() {
        let mut frame = [RGB8::default(); 8];
        let base = Hsv {
            hue: 254,
            sat: 255,
            val: 128,
        };
        fill_rainbow_frame(&mut frame, base);
        for (pair, hue) in frame.as_chunks::<2>().0.iter().zip([254, 255, 0, 1]) {
            assert_eq!(pair, &[hsv2rgb(Hsv { hue, ..base }); 2]);
        }
    }
}
