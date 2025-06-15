use smart_leds::{
    colors::{BLACK, WHITE},
    RGB8,
};

/// TODO: should this take an
pub fn flashlight(light_data: &mut [RGB8]) {
    for (i, x) in light_data.iter_mut().enumerate() {
        if i % 2 == 0 {
            *x = WHITE;
        } else {
            *x = BLACK;
        }
    }
}
