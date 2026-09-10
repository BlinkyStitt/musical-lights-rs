//! I'm really not sure i like this pattern of them all taking a &mut. I think they should maybe be using the time instead of
//!
//! Ideas for more patterns:
//! - A perfect game of snake using a hamiltonian cycle
//! - Turn FFT outputs into a color. shift the canvas and then draw the color

mod clock;
mod color_correction;
mod dancing_lights;
mod flag;
mod font;
mod gradient;
mod matrix;
mod networked;
mod pattern;
mod visualizer;

pub use color_correction::{LedResponse, convert_color, screen_color};
pub use dancing_lights::{Bands, DancingLights};
pub use flag::{flag_pattern, flag_stars_pattern, flag_stripes_pattern};
pub use gradient::Gradient;
pub use matrix::{Layout, SimpleXY, SnakeXY};

mod rainbow_frame;
pub use rainbow_frame::fill_rainbow_frame;
