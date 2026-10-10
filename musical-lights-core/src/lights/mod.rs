//! I'm really not sure i like this pattern of them all taking a &mut. I think they should maybe be using the time instead of
//!
//! Ideas for more patterns:
//! - A perfect game of snake using a hamiltonian cycle
//! - Turn FFT outputs into a color. shift the canvas and then draw the color

mod bands;
mod clock;
mod color_correction;
mod flag;
mod font;
mod gradient;
pub mod jacket;
mod matrix;
mod networked;
mod pattern;
mod visualizer;

pub use bands::Bands;
pub use color_correction::{LedResponse, convert_color, screen_color};
pub use flag::{flag_pattern, flag_stars_pattern, flag_stripes_pattern};
pub use gradient::Gradient;
pub use matrix::{Layout, SimpleXY, SnakeXY};

mod rainbow_frame;
pub use rainbow_frame::fill_rainbow_frame;

pub mod dance;
pub mod musical_motion;

pub mod bar_motion;
