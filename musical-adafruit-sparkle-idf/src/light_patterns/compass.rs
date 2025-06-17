use smart_leds::{
    hsv::{hsv2rgb, Hsv},
    RGB8,
};

use crate::{light_patterns::loading, State};

/// TODO: actually show the compass
pub fn compass(base_hsv: Hsv, light_data: &mut [RGB8], state: &State) {
    if state.magnetometer.is_none() || state.self_coordinate.is_none() {
        return loading(base_hsv, light_data, state);
    }

    for (i, x) in light_data.iter_mut().enumerate() {
        let mut new = base_hsv;

        new.hue = new.hue.wrapping_add((i / 2) as u8);

        *x = hsv2rgb(new);
    }
}
