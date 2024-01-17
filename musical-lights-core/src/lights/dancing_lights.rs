//! Based on the visualizer, but with some artistic choices to make the lights look they are dancing.
use super::MermaidGradient;
use crate::audio::ExponentialScaleAmplitudes;
use crate::lights::xy_to_n;
use crate::logging::{info, trace};

#[allow(unused_imports)]
use micromath::F32Ext;
use smart_leds::RGB8;

/// TODO: this is probably going to be refactored several times
/// TODO: keep generic PixelColor
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
    pub fn new(gradient: MermaidGradient) -> Self {
        // TODO: compile time assert
        debug_assert_eq!(X * Y, N);

        let mut fbuf = [RGB8::default(); N];

        // fill the framebuf with the gradient. just the top and bottom pixels start filled

        for y in 0..Y {
            // TODO: something is wrong with this gradient code. it always gives nearly off numbers
            let (r, g, b) = gradient.get(y, Y);

            let r = 255;

            // TODO: need a helper to go from n -> (x, y) and (x, y) -> n
            // TODO: handle different layouts
            let inside = xy_to_n(0, y, X);
            let outside = xy_to_n(X - 1, y, X);
            // let top = xy_to_n(x, Y - 1, X);

            info!("{} ({}): {} {} {}", y, inside, r, g, b);

            let rgb = (r, g, b).into();

            // TODO: fill top and bottom LED for the row
            fbuf[inside] = rgb;
            fbuf[outside] = rgb;
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

        const WHITE: RGB8 = RGB8::new(255, 255, 255);
        const BLACK: RGB8 = RGB8::new(0, 0, 0);

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
            // let inside_n = xy_to_n(0, y, X);

            // let color = self.fbuf[inside_n];

            // for x in 1..(X - 1) {
            //     let n = xy_to_n(x, y, X);

            //     // TODO: do different things based on if it went up or down or stayed the same
            //     if x == *channel as usize && x > last as usize {
            //         // if it went up, top should be white
            //         // TODO: silver instead?
            //         self.fbuf[n] = WHITE;
            //     } else if x <= *channel as usize {
            //         self.fbuf[n] = color;
            //     } else {
            //         self.fbuf[n] = BLACK;
            //     }
            // }
        }

        info!("channels: {:?}", self.channels);
    }
}

#[cfg(test)]
mod tests {}
