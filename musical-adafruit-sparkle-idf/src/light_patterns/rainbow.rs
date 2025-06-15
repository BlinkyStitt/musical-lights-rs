use smart_leds::{
    hsv::{hsv2rgb, Hsv},
    RGB8,
};

pub fn rainbow(base_hsv: Hsv, light_data: &mut [RGB8]) {
    for (i, x) in light_data.iter_mut().enumerate() {
        let mut new = base_hsv;

        new.hue = new.hue.wrapping_add((i / 2) as u8);

        *x = hsv2rgb(new);
    }
}
