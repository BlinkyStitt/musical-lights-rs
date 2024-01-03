//! Based on the visualizer, but with some artistic choices to make the lights look they are dancing.

use crate::microphone::EqualLoudness;

/// TODO: i think this should be a trait. the mac impl needs to draw a window, the hats need to control leds, etc.
pub struct DancingLights<const N: usize> {
    pub lights: [u8; N],
}

impl<const N: usize> DancingLights<N> {
    pub fn new() -> Self {
        Self { lights: [0; N] }
    }

    // TODO: need to think more about &mut on this
    pub fn update(&mut self, loudness: EqualLoudness<N>) {
        // todo!("do something with the loudness to turn it into lights")
    }
}

impl<const N: usize> Default for DancingLights<N> {
    fn default() -> Self {
        Self::new()
    }
}
