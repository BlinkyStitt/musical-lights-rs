//! Based on the visualizer, but with some artistic choices to make the lights look they are dancing.

use super::MermaidGradient;
use crate::audio::ExponentialScaleAmplitudes;
use crate::lights::{Layout, SnakeXY};
use crate::logging::{info, trace};

#[allow(unused_imports)]
use micromath::F32Ext;
use smart_leds::colors::{BLACK, SILVER};
use smart_leds::RGB8;

/// TODO: this is probably going to be refactored several times
pub struct DancingLights<const X: usize, const Y: usize, const N: usize> {
    channels: [u8; Y],
    /// TODO: use a framebuf crate that supports DMA and drawing fonts and such
    pub fbuf: [RGB8; N],
}

/// TODO: macro for all the different inverts
impl<const X: usize, const Y: usize, const N: usize> DancingLights<X, Y, N> {
    /// ```
    /// let mut data = DancingLights::new_buffer();
    /// let mut dancing_lights = DancingLights::new(&mut data);
    /// ```
    /// TODO: generic gradient
    /// TODO: generic layout
    pub fn new(gradient: MermaidGradient<Y>) -> Self {
        // TODO: compile time assert
        debug_assert_eq!(X * Y, N);

        let mut fbuf = [RGB8::default(); N];

        // fill the framebuf with the gradient. just the top and bottom pixels start filled

        for y in 0..Y {
            // TODO: something is wrong with this gradient code. it always gives nearly off numbers
            let rgb_color = gradient.colors[y];

            // TODO: handle different layouts
            let inside = SnakeXY::xy_to_n(0, y, X);
            let outside = SnakeXY::xy_to_n(X - 1, y, X);

            info!(
                "{} ({}): {} {} {}",
                y, inside, rgb_color.r, rgb_color.g, rgb_color.b
            );

            // TODO: fill top and bottom LED for the row
            fbuf[inside] = rgb_color;
            fbuf[outside] = rgb_color;
        }

        // TODO: get rid of channels. just use the fbuf
        let channels = [0; Y];

        Self { channels, fbuf }
    }

    pub fn update(&mut self, loudness: ExponentialScaleAmplitudes<Y>) {
        trace!("{:?}", loudness);

        // TODO: we want a recent min/max (with decay), not just the min/max from the current frame
        let mut min = f32::MAX;
        let mut max = f32::MIN;

        // TODO: .0.0 is weird. loudness should be Iter
        for &loudness in loudness.0 .0.iter() {
            min = min.min(loudness);
            max = max.max(loudness);
        }

        for (y, (&loudness, channel)) in loudness
            .0
             .0
            .iter()
            .zip(self.channels.iter_mut())
            .enumerate()
        {
            // TODO: use remap helper function
            let scaled = (loudness - min) / (max - min) * (X - 1) as f32;

            let scaled = scaled.round() as u8;

            let last = *channel;

            // TODO: decay even slower. keep track of a last time we updated each channel and only decay if it's been long enough to prevent epilepsy
            *channel = scaled.max((*channel).saturating_sub(1));

            // // TODO: draw to fbuf here
            let inside_n = SnakeXY::xy_to_n(0, y, X);

            let color = self.fbuf[inside_n];

            // just the inner ring
            for x in 1..(X - 1) {
                let n = SnakeXY::xy_to_n(x, y, X);

                if x == *channel as usize && x > last as usize {
                    // if it went up, do something special. maybe just bump the brightness instead of going full silver
                    self.fbuf[n] = SILVER;
                } else if x <= *channel as usize {
                    self.fbuf[n] = color;
                } else {
                    // make sure they are off
                    // TODO: this could probably be skipped. probably better to dim instead of turn it off entireley
                    self.fbuf[n] = BLACK;
                }
            }
        }

        info!("channels: {:?}", self.channels);
    }
}

#[cfg(test)]
mod tests {}
