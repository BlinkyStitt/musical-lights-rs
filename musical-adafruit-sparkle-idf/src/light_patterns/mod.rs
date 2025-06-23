//! NOTE: Once these patterns stabalize, we should move them into musical-lights-core
//!
//! TODO: think more about this pattern. i kind of think it should be an iterator that gives NUM_LEDS number of items for every frame
//! TODO: theres two ways to do these animations. 1 is to use a frame counter, the other is to use the time. i think i like using time more (thats what i did with fastled)
//!
//! TODO: some sort of transition pattern?
//! TODO: how can we layer patterns? I'd like to scroll out text over top. i think its time to learn how the embedded_graphics crate does things
mod clock;
mod compass;
mod fibonacci_layout;
mod flashlight;
mod loading;
mod mic_fire;
mod rainbow;
mod startup;

pub use clock::clock;
pub use compass::compass;
pub use flashlight::flashlight;
pub use loading::loading;
pub use mic_fire::MicFire;
pub use rainbow::rainbow;
pub use startup::startup;
