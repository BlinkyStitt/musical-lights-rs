//! Based on the visualizer, but with some artistic choices to make the lights look they are dancing.
use crate::audio::BarkScaleAmplitudes;
use crate::logging::info;
use micromath::F32Ext;

/// TODO: this is probably going to be refactored several times
pub struct DancingLights<const X: usize, const Y: u8> {
    channels: [u8; X],
}

/// TODO: macro for all the different inverts
impl<const X: usize, const Y: u8> DancingLights<X, Y> {
    pub fn new() -> Self {
        Self { channels: [0; X] }
    }

    pub fn update(&mut self, loudness: BarkScaleAmplitudes) {
        info!("{:?}", loudness);

        let mut min = f32::MAX;
        let mut max = f32::MIN;

        // TODO: .0.0 is weird
        for &loudness in loudness.0 .0.iter() {
            min = min.min(loudness);
            max = max.max(loudness);
        }

        for (&loudness, channel) in loudness.0 .0.iter().zip(self.channels.iter_mut()) {
            let scaled = (loudness - min) / (max - min) * Y as f32;

            let scaled = scaled.round() as u8;

            // TODO: flick protection where? is that on the drawing side? what about decay?
            *channel = scaled;
        }
    }
}
