use smart_leds::{
    hsv::{hsv2rgb, Hsv},
    RGB8,
};

pub fn rainbow(base_hsv: Hsv, light_data: &mut [RGB8]) {
    for (i, x) in light_data.iter_mut().enumerate() {
        let mut new = base_hsv;

        // TODO: add or sub?
        new.hue = new.hue.wrapping_add((i / 2) as u8);

        // TODO: need fastled's rainbow spectrum code here. though maybe we should just do a pallet?
        *x = hsv2rgb(new);
    }
}
