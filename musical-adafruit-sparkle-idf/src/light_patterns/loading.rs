use smart_leds::{
    hsv::{hsv2rgb, Hsv},
    RGB8,
};

use crate::State;

/// TODO: actually show the compass
pub fn loading(base_hsv: Hsv, light_data: &mut [RGB8], state: &State) {
    // TODO: divide the remaining space into a cool rotating swirl. or maybe just cylon this?
    for (i, x) in light_data.iter_mut().enumerate() {
        let mut new = base_hsv;

        new.hue = new.hue.wrapping_add((i / 2) as u8);

        *x = hsv2rgb(new);
    }
}
