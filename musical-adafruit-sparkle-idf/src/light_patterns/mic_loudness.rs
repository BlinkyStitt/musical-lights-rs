//! Loudness is the subjective perception of how intense or strong a sound is, as interpreted by the human ear.
//!
//! the initial idea was to use the [fire2012](https://github.com/FastLED/FastLED/blob/master/examples/Fire2012/Fire2012.ino) patterns from fastled, but instead of randomly adding heat, we add heat based on frequency amplitudes
//!
//! make it work, make it right, make it fast. don't get caught up making perfect iterators on this first pass!
use core::f32;
use std::fmt::Display;

use itertools::{Itertools, MinMaxResult};
use musical_lights_core::audio::{AggregatedBinsBuilder, FftOutputs};
use musical_lights_core::remap;

/// TODO: i'm not sure where the code that turns this heat into a XY matrix belongs. or code for rotating the matrix by frame count
/// TODO: this doesn't work exactly the same as Fire2012. maybe i should have kept it more similar at the start?
pub struct MicLoudnessPattern<
    const FFT_OUTPUTS: usize,
    const N: usize,
    const X: usize,
    const Y: usize,
    S: AggregatedBinsBuilder<FFT_OUTPUTS, X>,
> {
    fft_out_buf: [f32; FFT_OUTPUTS],
    scale_builder: S,
    /// TODO: how can we make this an AggregatedBins?
    scale_out_buf: [f32; X],
    /// how many rows are lit up for each column of the matrix. range of 0-Y
    loudness: [u8; X],
    /// TODO: what should floor_db be? should it be dynamic for each X?
    /// TODO: the higher frequency groups need a higher floor db. or we need to work more on the windowing/bucketing/etc
    /// TODO: i think we should change from average to RMS and see how that changes things first
    floor_db: f32,
    floor_peak_db: f32,
    /// if the column was louder this tick than the previous tick
    sparkle: [bool; X],
    /// 1.0 == 100%
    sparkle_chance: f32,
    peak_ema_min_dbfs: f32,
    peak_ema_max_dbfs: f32,
    ema_dbfs: f32,
}

/// TODO: i'm not sure the bet way to pack this. not worth optimizing at this point, so lets KISS.
/// TODO: i'm not even sure how we should make this work
pub struct MicLoudnessTick<'a, const X: usize, const Y: usize> {
    /// the max value of loudness is `Y`
    pub loudness: &'a [u8; X],
    pub sparkle: &'a [bool; X],
}

impl<const FFT_OUTPUTS: usize, const N: usize, const X: usize, const Y: usize, S>
    MicLoudnessPattern<FFT_OUTPUTS, N, X, Y, S>
where
    S: AggregatedBinsBuilder<FFT_OUTPUTS, X>,
{
    #[deprecated(note = "i like the filter bank way more")]
    pub const fn new(
        uninit_scale_builder: S,
        floor_db: f32,
        floor_peak_db: f32,
        sparkle_chance: f32,
    ) -> Self {
        assert!(X * Y == N, "wrong dimensions");
        assert!(sparkle_chance == 1.0, "only 1.0 is currently supported");

        let peak_ema_min_dbfs = floor_db;
        let peak_ema_max_dbfs = floor_peak_db;

        let ema_dbfs = (floor_db + floor_peak_db) / 2.0;

        Self {
            fft_out_buf: [0.0; FFT_OUTPUTS],
            scale_builder: uninit_scale_builder,
            scale_out_buf: [0.0; X],
            loudness: [0; X],
            floor_db,
            floor_peak_db,
            sparkle: [false; X],
            sparkle_chance,
            peak_ema_min_dbfs,
            peak_ema_max_dbfs,
            ema_dbfs,
        }
    }

    /// You must call this before using new!
    pub fn init(&mut self, sample_rate_hz: f32) {
        self.scale_builder.init(sample_rate_hz);
    }

    /// TODO: i need to learn more about AGC because I think that's the right thing to use here
    fn update_max(&mut self, max: f32) {
        const ALPHA: f32 = 0.1;

        if max > self.peak_ema_max_dbfs {
            self.peak_ema_max_dbfs = max;
        } else {
            // TODO: ema here? circular buffer for true maxes here? we are going to display like 20 frames, so we should keep the maxes of the last 20?
            // TODO: max from config
            // TODO: in the past i had a fixed decay. it seems there is disagrement about what the human ear/brain even do.
            self.peak_ema_max_dbfs = (self.peak_ema_max_dbfs * (1. - ALPHA)) + (max * ALPHA);
        }
        self.peak_ema_max_dbfs = self.peak_ema_max_dbfs.max(self.floor_peak_db);
    }

    /// TODO: this is very similar to update_max, but the signs are flipped.
    fn update_min(&mut self, min: f32) {
        const ALPHA: f32 = 0.1;

        if min < self.peak_ema_min_dbfs {
            self.peak_ema_min_dbfs = min;
        } else {
            // TODO: ema here? circular buffer for true mins here? we are going to display like 20 frames, so we should keep the maxes of the last 20?
            // TODO: less float math! (maybe. this isn't a tiny controller so maybe its fine)
            self.peak_ema_min_dbfs = (self.peak_ema_min_dbfs * (1. - ALPHA)) + (min * ALPHA);
        }
        self.peak_ema_min_dbfs = self.peak_ema_min_dbfs.min(self.floor_db);
    }

    fn update_ema(&mut self) {
        const ALPHA: f32 = 0.1;

        // TODO: is there an "average" iter?
        // TODO: should we just take the midpoint of the min and max? probably not
        // TODO: should this be a real average instead of an ema? sum the samples buffer
        let avg_dbfs = self.fft_out_buf.iter().sum::<f32>() / self.fft_out_buf.len() as f32;

        self.ema_dbfs = (self.ema_dbfs * (1. - ALPHA)) + avg_dbfs * ALPHA;
    }

    fn fill_fft_out_buf<'fft, const NUM_FFT_OUTPUTS: usize>(
        &mut self,
        spectrum: &FftOutputs<'fft, NUM_FFT_OUTPUTS>,
    ) {
        // TODO: iter_mean_square_power_density? or just iter_power?
        self.fft_out_buf
            .iter_mut()
            .set_from(spectrum.iter_mean_square_power_density());
        // yield_now();
    }

    /// TODO: keep refactoring this. some of this probably belongs on FftOutputs
    pub fn tick_fft_outputs<'fft, const NUM_FFT_OUTPUTS: usize>(
        &mut self,
        spectrum: &FftOutputs<'fft, NUM_FFT_OUTPUTS>,
    ) -> MicLoudnessTick<'_, X, Y> {
        // TODO: use loudness_into instead? it needs output to be the S::Output type though and I'm not sure how to do that
        self.fill_fft_out_buf(spectrum);

        // TODO: i'm not sure that i like this. can't decide if sum is the right way to do human perceived loudness
        // TODO: exponential scale_builder should give us dbfs? or should the FftOutput? too many types
        self.scale_builder
            .sum_power_into(&self.fft_out_buf, &mut self.scale_out_buf);
        // yield_now();
        // info!("exponential_scale_outputs: {:?}", exponential_scale_outputs);

        // Convert each band energy to RMS amplitude in dbfs
        // TODO: this should maybe be 10. * rms.log10, but I'm really just guessing. read more
        // TODO: if this is a big buf, we might need to yield more often
        for x in self.scale_out_buf.iter_mut() {
            let rms = x.sqrt();
            *x = 20. * rms.log10();
        }
        // yield_now();

        // TODO: how should we use an AGC?
        // self.agc.process(dbfs);

        // TODO: print the dbfs for debugging. we need some tests to make sure the input dbfs make sense. i think they are too low right now

        // EMA for tracking the min/avg/max
        // TODO: this is not right
        match self.scale_out_buf.iter().minmax() {
            MinMaxResult::NoElements => todo!(),
            MinMaxResult::OneElement(&x) => {
                self.update_min(x);
                self.update_max(x);
            }
            MinMaxResult::MinMax(&min, &max) => {
                self.update_min(min);
                self.update_max(max);
            }
        }
        self.update_ema();
        // yield_now();

        for ((loudness, x), sparkle) in self
            .loudness
            .iter_mut()
            .zip(self.scale_out_buf.iter().copied())
            .zip(self.sparkle.iter_mut())
        {
            // capture the previous loudness so we can compare
            let old_loudness = *loudness;

            // TODO: scale this on the average instead of the floor? or maybe cut the bottom 25%? `a` and `c` definitely need thought
            *loudness = (remap(x, self.floor_db, self.peak_ema_max_dbfs, 0.0, Y as f32)
                .clamp(0.0, Y as f32)) as u8;

            // TODO: only sparkle if its the top-most band overall
            // TODO: "band" or "channel"? I'm inconsistent
            *sparkle = *loudness > old_loudness;
        }
        // yield_now();

        MicLoudnessTick {
            loudness: &self.loudness,
            sparkle: &self.sparkle,
        }
    }
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
                (true, x) => f.write_fmt(format_args!("*{x}*|"))?,
                (false, x) => f.write_fmt(format_args!(" {x} |"))?,
            }
        }

        Ok(())
    }
}
