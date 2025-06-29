//! Loudness is the subjective perception of how intense or strong a sound is, as interpreted by the human ear.
//!
//! the initial idea was to use the [fire2012](https://github.com/FastLED/FastLED/blob/master/examples/Fire2012/Fire2012.ino) patterns from fastled, but instead of randomly adding heat, we add heat based on frequency amplitudes
//!
//! make it work, make it right, make it fast. don't get caught up making perfect iterators on this first pass!
use core::f32;
use std::fmt::Display;
use std::thread::yield_now;

use itertools::{Itertools, MinMaxResult};
use musical_lights_core::logging::info;
use musical_lights_core::remap;

/// TODO: i'm not sure where the code that turns this heat into a XY matrix belongs. or code for rotating the matrix by frame count
/// TODO: this doesn't work exactly the same as Fire2012. maybe i should have kept it more similar at the start?
pub struct MicLoudnessPattern<const N: usize, const X: usize, const Y: usize> {
    /// how many rows are lit up for each column of the matrix. range of 0-Y
    loudness: [u8; X],
    /// TODO: what should floor_db be? should it be dynamic for each X?
    /// TODO: the higher frequency groups need a higher floor db. or we need to work more on the windowing/bucketing/etc
    /// TODO: i think we should change from average to RMS and see how that changes things first
    floor_db: f32,
    floor_peak_db: f32,
    /// if the column was louder this tick than the previous tick
    sparkle: [bool; X],
    peak_ema_min_dbfs: f32,
    peak_ema_max_dbfs: f32,
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
    pub const fn new(floor_db: f32, floor_peak_db: f32) -> Self {
        assert!(X * Y == N);

        let peak_ema_min_dbfs = floor_db;
        let peak_ema_max_dbfs = floor_peak_db;

        Self {
            loudness: [0; X],
            floor_db,
            floor_peak_db,
            sparkle: [false; X],
            peak_ema_min_dbfs,
            peak_ema_max_dbfs,
        }
    }

    /// TODO: keep refactoring this. some of this probably belongs on FftOutputs
    pub fn tick_fft_outputs<'fft, const NUM_FFT_OUTPUTS: usize>(
        &mut self,
        spectrum: FFtOutputs<'fft, NUM_FFT_OUTPUTS>,
    ) -> MicLoudnessTick<'_, X, Y> {
        self.fft_outputs_buf
            .iter_mut()
            .set_from(spectrum.iter_mean_square_power_density());

        // Collapse to a single-sided spectrum (bins 1…N/2-1) by doubling power there; leave DC (k = 0) and Nyquist (k = N/2) unchanged.
        // also apply weigthing (a-weighting or some other equal loudness countour)
        // TODO: double check this. too much cargo culting
        for (x, w) in self
            .fft_outputs_buf
            .iter_mut()
            .zip(weights.iter())
            .take(FFT_OUTPUTS - 1)
            .skip(1)
        {
            *x *= 2.0 * w;
        }

        // calculating the weights can be slow. yield now
        // TODO: do some analysis to see if this is always needed. this one can probably be removed
        yield_now();

        // TODO: i'm not sure that i like this. can't decide if sum is the right way to do human perceived loudness
        // TODO: exponential scale_builder should give us dbfs? or should the FftOutput? too many types
        self.scale_builder
            .sum_into(self.fft_outputs_buf, self.scale_outputs_buf);
        // info!("exponential_scale_outputs: {:?}", exponential_scale_outputs);

        // Convert each band energy to RMS amplitude in dbfs
        for x in scale_outputs_buf.iter_mut() {
            let rms = x.sqrt();
            *x = 20. * rms.log10();
        }

        // calculating the exponential scale can be slow. yield now
        // TODO: do some analysis to see if this is always needed. this one can probably be removed
        yield_now();

        self.tick_dbfs(exponential_scale_outputs)
    }

    /// TODO: take the spectrum or dbfs? maybe both
    /// TODO: should this take an AggregatedAmplitudes or a ref? We need a AggregatedAmplitudesRef type maybe? seems verbose
    /// TODO: or maybe this should take `powers` instead of `amplitudes`? maybe a type that lets us pick? I'm really not sure what units we want!
    pub fn tick_dbfs(&mut self, dbfs: &[f32; X]) -> MicLoudnessTick<'_, X, Y> {
        // TODO: how should we use an AGC?
        // self.agc.process(dbfs);

        // TODO: print the dbfs for debugging. we need some tests to make sure the input dbfs make sense. i think they are too low right now

        // EMA for tracking the min/avg/max
        // TODO: this is not right
        match dbfs.iter().minmax() {
            MinMaxResult::NoElements => todo!(),
            MinMaxResult::OneElement(&x) => todo!(),
            MinMaxResult::MinMax(&min, &max) => {
                // // TODO: include self.floor_db in this too
                // if min < self.peak_ema_min_dbfs {
                //     self.peak_ema_min_dbfs = min;
                // } else {
                //     // todo!("do an ema");
                //     self.peak_ema_min_dbfs = min;
                // }

                if max > self.peak_ema_max_dbfs {
                    self.peak_ema_max_dbfs = max;
                } else {
                    // TODO: ema here? circular buffer for true maxes here? we are going to display like 20 frames, so we should keep the maxes of the last 20?
                    // TODO: max from config
                    self.peak_ema_max_dbfs = (self.peak_ema_max_dbfs + max) / 2.0;
                }
                self.peak_ema_max_dbfs = self.peak_ema_max_dbfs.max(self.floor_peak_db);

                // info!("dbfs range: {}..{}/{}", min, max, self.peak_ema_max_dbfs);

                // self.peak_ema_max_dbfs = self.peak_ema_max_dbfs.min(0.0);
            }
        }

        yield_now();

        for ((loudness, x), sparkle) in self
            .loudness
            .iter_mut()
            .zip(dbfs.iter().copied())
            .zip(self.sparkle.iter_mut())
        {
            // capture the previous loudness so we can compare
            let old_loudness = *loudness;

            // TODO: scale
            *loudness = (remap(x, self.floor_db, self.peak_ema_max_dbfs, 0.0, 1.0).clamp(0.0, 1.0)
                * Y as f32) as u8;

            // TODO: only sparkle if its the top-most band overall
            // TODO: "band" or "channel"? I'm inconsistent
            *sparkle = *loudness > old_loudness;
        }

        MicLoudnessTick {
            loudness: &self.loudness,
            sparkle: &self.sparkle,
        }
    }
}
