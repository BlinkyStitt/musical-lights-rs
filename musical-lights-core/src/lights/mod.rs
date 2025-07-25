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

pub use color_correction::convert_color;
pub use dancing_lights::{Bands, DancingLights};
pub use gradient::{Gradient, apply_greg_caitlin_wedding_spline};
pub use matrix::{Layout, SimpleXY, SnakeXY};
