use smart_leds::{
    hsv::{hsv2rgb, Hsv},
    RGB8,
};

use crate::State;

/// TODO: actually show the compass
/// TODO: this should be a struct that keeps track of where it is in this pattern.
pub fn startup(base_hsv: Hsv, light_data: &mut [RGB8], state: &State) {
    // TODO: 1 red
    // TODO: 1 blank
    // TODO: 2 green
    // TODO: 1 blank
    // TODO: 3 blue
    // TODO: 1 blank
    // TODO: 1 white
    // TODO: 1 blank
    // TODO: give the remaining space to a "loading" spinner?

    for (i, x) in light_data.iter_mut().enumerate() {
        let mut new = base_hsv;

        new.hue = new.hue.wrapping_add((i / 2) as u8);

        *x = hsv2rgb(new);
    }
}
