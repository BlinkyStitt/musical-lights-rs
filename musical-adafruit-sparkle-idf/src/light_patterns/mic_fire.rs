//! based on the [fire2012](https://github.com/FastLED/FastLED/blob/master/examples/Fire2012/Fire2012.ino) patterns from fastled, but instead of randomly adding heat, we add heat based on frequency amplitudes

use musical_lights_core::{audio::AggregatedAmplitudes, remap};

/// TODO: i'm not sure where the code that turns this heat into a XY matrix belongs. or code for rotating the matrix by frame count
/// TODO: this doesn't work exactly the same as Fire2012. maybe i should have kept it more similar at the start?
pub struct MicFire<const N: usize, const X: usize, const Y: usize> {
    /// COOLING: How much does the air cool as it rises?
    /// Less cooling = taller flames.  More cooling = shorter flames.
    /// Default 50, suggested range 20-100
    cooling_per_tick: u8,
    /// how many rows are lit up for each column of the matrix. range of 0-Y
    heat: [u8; X],
    /// if the column was heated this tick
    heating: [bool; X],
}

impl<const N: usize, const X: usize, const Y: usize> MicFire<N, X, Y> {
    pub const fn new(cooling_per_tick: u8) -> Self {
        assert!(X * Y == N);

        Self {
            cooling_per_tick,
            heat: [0; X],
            heating: [false; X],
            // matrix: [0; N],
        }
    }

    // make it work, make it right, make it fast. don't get caught up making perfect iterators on this first pass!
    // TODO: should this take an AggregatedAmplitudes or a ref? We need a AggregatedAmplitudesRef type maybe? seems verbose
    pub fn tick(&mut self, amplitudes: &[f32; X]) -> (&[u8; X], &[bool; X]) {
        // Step 1. Cool down every column a little. then add new heat based on the amplitudes
        // TODO: EMA tracking the overall heat? use this for scaling the Y-axis?
        for ((heat, amplitude), heating) in self
            .heat
            .iter_mut()
            .zip(amplitudes.iter())
            .zip(self.heating.iter_mut())
        {
            // cool down every column a little
            let cooled = heat.saturating_sub(self.cooling_per_tick);

            // TODO: can't decide if we should add new_heat, or just set it as the max
            let new_heat = remap(*amplitude, 0.0, 1.0, 0.0, Y as f32) as u8;

            if new_heat > cooled {
                *heat = new_heat;
                *heating = true;
            } else {
                *heat = cooled;
                *heating = false;
            }
        }

        // TODO: diffuse some heat upwards in a buffer?

        // TODO: what should the return look like?
        (&self.heat, &self.heating)
    }
}
