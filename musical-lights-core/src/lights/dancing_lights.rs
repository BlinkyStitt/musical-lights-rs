//! Based on the visualizer, but with some artistic choices to make the lights look they are dancing.
use core::fmt::Display;

use super::Gradient;
use crate::audio::AggregatedBins;
use crate::lights::{Layout, SnakeXY};
use crate::logging::{debug, info, trace};
use crate::remap;
use smart_leds::RGB8;
use smart_leds::colors::{BLACK, SILVER};

/// TODO: do we need this?
#[cfg(feature = "libm")]
use micromath::F32Ext;

/// TODO: i'm not sure i actually need this. i'm rewritting this for the net and not using this code. but maybe i should keep using it?
/// TODO: at this point, should this be scaled 0-255? right now its the number of lights
/// TODO: this used to be called "channels" but i don't think thats correct
pub struct Bands<const N: usize>([u8; N]);

impl<const N: usize> Display for Bands<N> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        for y_height in self.0.iter() {
            match y_height {
                0 => {
                    f.write_str("   |")?;
                }
                // TODO: make this work with more than 9. also track going up or down.
                _ => f.write_fmt(format_args!(" {y_height} |"))?,
            }
        }

        Ok(())
    }
}

/// TODO: this is probably going to be refactored several times
pub struct DancingLights<const X: usize, const Y: usize, const N: usize> {
    bands: Bands<Y>,
    /// TODO: use a framebuf crate that supports DMA and drawing fonts and such
    pub fbuf: [RGB8; N],
    /// recent maximum loudness. decays over time
    pub peak_max: f32,
    /// how fast to decay peak_max
    pub decay_alpha: f32,
}

/// TODO: macro for all the different inverts
impl<const X: usize, const Y: usize, const N: usize> DancingLights<X, Y, N> {
    pub fn new(gradient: Gradient<Y>, peak_decay: f32) -> Self {
        // TODO: compile time assert
        debug_assert_eq!(X * Y, N);

        let mut fbuf = [RGB8::default(); N];

        // fill the framebuf with the gradient. just the top and bottom pixels start filled

        for y in 0..Y {
            // TODO: something is wrong with this gradient code. it always gives nearly off numbers
            let rgb_color = gradient.colors[y];

            // TODO: handle different layouts
            let inside = SnakeXY::xy_to_n(0, y, X);
            // let outside = SnakeXY::xy_to_n(X - 1, y, X);

            info!(
                "{} ({}): {} {} {}",
                y, inside, rgb_color.r, rgb_color.g, rgb_color.b
            );

            // TODO: fill top and bottom LED for the row
            fbuf[inside] = rgb_color;
            // fbuf[outside] = rgb_color;
        }

        // TODO: get rid of channels. just use the fbuf
        let bands = Bands([0; Y]);

        let peak_max = 0.1;

        // TODO: error for nonsense peak_decay

        let decay_alpha = peak_decay;

        Self {
            bands,
            fbuf,
            peak_max,
            decay_alpha,
        }
    }

    /// TODO: this X/Y is the opposite of how i usually think of things
    pub fn update(&mut self, loudness: AggregatedBins<Y>) {
        trace!("{:?}", loudness);

        // TODO: we want a recent min/max (with decay), not just the min/max from the current frame
        // TODO: what default?
        let mut current_max = -100.0f32;
        let mut current_min = 100.0f32;

        for loudness in loudness.0.iter().copied() {
            current_max = current_max.max(loudness);
            current_min = current_min.min(loudness);
        }

        // TODO: decay how fast?
        let decayed_peak = self.peak_max * self.decay_alpha;

        self.peak_max = current_max.max(decayed_peak);

        // TODO: set a peak_min too.

        // this needs to be atleast one because thats how i currently store the color. that won't work if we change it to zoom into part of the spectrum
        const BOTTOM_BORDER: usize = 1;
        const TOP_BORDER: usize = 0;

        const BORDERS: usize = BOTTOM_BORDER + TOP_BORDER;

        for (y, (&loudness, channel)) in loudness.0.iter().zip(self.bands.0.iter_mut()).enumerate()
        {
            // TODO: log scale?
            let scaled =
                remap(loudness, -65., self.peak_max, 0.0, (X - BORDERS) as f32).round() as u8;

            let last = *channel;

            // TODO: decay even slower. keep track of a last time we updated each channel and only decay if it's been long enough to prevent epilepsy
            // *channel = scaled.max((*channel).saturating_sub(1));
            *channel = scaled;

            // get the index of the first pixel of the row. this always has the color we want
            let bottom_n = SnakeXY::xy_to_n(0, y, X);

            // get the color for this frequency. this was set when self was created
            let color = self.fbuf[bottom_n];

            // just the middle pixels. the edges are left always lit
            for x in BOTTOM_BORDER..(X - TOP_BORDER) {
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

        debug!("bands: {}", self.bands);
    }

    pub fn iter(&self, y_offset: usize) -> impl Iterator<Item = &RGB8> {
        // TODO: store as SimpleXY and then convert inside `iter` and `iter_flipped_x`?
        // the fbuf is already laid out as SnakeXY.
        (0..N).map(move |n| {
            let (x, y) = SnakeXY::n_to_xy(n, X);

            let offset_y = (y + y_offset) % Y;

            let flipped_n = SnakeXY::xy_to_n(x, offset_y, X);

            &self.fbuf[flipped_n]
        })
    }

    pub fn iter_flipped_x(&self, y_offset: usize) -> impl Iterator<Item = &RGB8> {
        (0..N).map(move |n| {
            let (flipped_x, y) = SnakeXY::n_to_flipped_x_and_y(n, X);

            let offset_y = (y + y_offset) % Y;

            let flipped_n = SnakeXY::xy_to_n(flipped_x, offset_y, X);

            &self.fbuf[flipped_n]
        })
    }
}

#[cfg(test)]
mod tests {}
