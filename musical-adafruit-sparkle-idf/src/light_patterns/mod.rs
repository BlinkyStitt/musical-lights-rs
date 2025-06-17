//! TODO: think more about this pattern. i kind of think it should be an iterator that gives NUM_LEDS number of items for every frame
//! TODO: theres two ways to do these animations. 1 is to use a frame counter, the other is to use the time. i think i like using time more (thats what i did with fastled)
mod clock;
mod compass;
mod flashlight;
mod loading;
mod rainbow;
mod startup;

pub use clock::clock;
pub use compass::compass;
pub use flashlight::flashlight;
pub use loading::loading;
pub use rainbow::rainbow;
pub use startup::startup;

// TODO:
