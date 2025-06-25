//! Loudness is the subjective perception of how intense or strong a sound is, as interpreted by the human ear.
//!
//! the initial idea was to use the [fire2012](https://github.com/FastLED/FastLED/blob/master/examples/Fire2012/Fire2012.ino) patterns from fastled, but instead of randomly adding heat, we add heat based on frequency amplitudes
//!
//! make it work, make it right, make it fast. don't get caught up making perfect iterators on this first pass!
use std::fmt::Display;

/// TODO: i'm not sure where the code that turns this heat into a XY matrix belongs. or code for rotating the matrix by frame count
/// TODO: this doesn't work exactly the same as Fire2012. maybe i should have kept it more similar at the start?
pub struct MicLoudnessPattern<const N: usize, const X: usize, const Y: usize> {
    /// how many rows are lit up for each column of the matrix. range of 0-Y
    loudness: [u8; X],
    /// TODO: what should floor_db be? should it be dynamic for each X?
    /// TODO: the higher frequency groups need a higher floor db. or we need to work more on the windowing/bucketing/etc
    /// TODO: i think we should change from average to RMS and see how that changes things first
    floor_db: f32,
    /// if the column was louder this tick than the previous tick
    sparkle: [bool; X],
}

/// TODO: i'm not sure the bet way to pack this. not worth optimizing at this point, so lets KISS.
/// TODO: i'm not even sure how we should make this work
pub struct MicLoudnessTick<'a, const X: usize, const Y: usize> {
    /// the max value of loudness is `Y`
    pub loudness: &'a [u8; X],
    pub sparkle: &'a [bool; X],
}

/// TODO: this could be much better i'm sure. but it works for now.
impl<const X: usize, const Y: usize> Display for MicLoudnessTick<'_, X, Y> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (x, y_height) in self.loudness.iter().enumerate() {
            match (self.sparkle[x], y_height) {
                (_, 0) => {
                    f.write_str("   |")?;
                }
                // TODO: make this work with more than 9
                (true, x) => f.write_fmt(format_args!("*{}*|", x))?,
                (false, x) => f.write_fmt(format_args!(" {} |", x))?,
            }
        }

        Ok(())
    }
}

impl<const N: usize, const X: usize, const Y: usize> MicLoudnessPattern<N, X, Y> {
    pub const fn new(floor_db: f32) -> Self {
        assert!(X * Y == N);

        Self {
            loudness: [0; X],
            floor_db,
            sparkle: [false; X],
        }
    }

    /// TODO: should this take an AggregatedAmplitudes or a ref? We need a AggregatedAmplitudesRef type maybe? seems verbose
    /// TODO: or maybe this should take `powers` instead of `amplitudes`?
    pub fn tick(&mut self, amplitudes: &[f32; X]) -> MicLoudnessTick<'_, X, Y> {
        // Step 1. Cool down every column a little. then add new heat based on the amplitudes
        // TODO: EMA tracking the overall heat? use this for scaling the Y-axis?
        for ((loudness, amplitude), sparkle) in self
            .loudness
            .iter_mut()
            .zip(amplitudes.iter())
            .zip(self.sparkle.iter_mut())
        {
            // TODO: if amplitude, dbfs = 20. * amplitude.log10();
            // TODO: if power, dbfs = 10. * power.log();
            // let dbfs = 10. * power.log10();
            let dbfs = 20. * amplitude.log10();

            // capture the previous loudness so we can compare
            let old_loudness = *loudness;

            // TODO: can't decide if we should add the new dbfs, or just set it as the max
            // TODO: or maybe decay and use the larger value?
            // TODO: this is probably not the right way to scale/clamp/round this
            *loudness = (((dbfs - self.floor_db) / -self.floor_db).clamp(0.0, 1.0) * Y as f32)
                .round() as u8;

            *sparkle = *loudness > old_loudness;
        }

        // TODO: diffuse some heat upwards in a buffer?

        MicLoudnessTick {
            loudness: &self.loudness,
            sparkle: &self.sparkle,
        }
    }
}
