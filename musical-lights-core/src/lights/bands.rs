use core::fmt::Display;
#[cfg(feature = "defmt")]
use defmt::write as defmt_write;
const RAMP_SHADE: &[char] = &[' ', '.', ':', '░', '▒', '▓', '█']; // U+2591..2593 :contentReference[oaicite:2]{index=2}

#[inline]
const fn glyph(val: u8, max: u8, ramp: &[char]) -> char {
    let idx = (val as usize * (ramp.len() - 1)) / (max as usize);
    ramp[idx]
}

/// TODO: i'm not sure i actually need this. i'm rewritting this for the net and not using this code. but maybe i should keep using it?
/// TODO: at this point, should this be scaled 0-255? right now its the number of lights
/// TODO: this used to be called "channels" but i don't think thats correct
/// TODO: allow this to be a float?
pub struct Bands<const N: usize, const MAX: u8>(pub [u8; N]);

impl<const N: usize, const MAX: u8> Display for Bands<N, MAX> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        for &v in self.0.iter() {
            f.write_fmt(format_args!(" {} |", glyph(v, MAX, RAMP_SHADE)))?
        }
        Ok(())
    }
}

#[cfg(feature = "defmt")]
impl<const N: usize, const MAX: u8> defmt::Format for Bands<N, MAX> {
    fn format(&self, fmt: defmt::Formatter) {
        for &y_height in self.0.iter() {
            if y_height == 0 {
                defmt_write!(fmt, "   |");
            } else {
                // Print single-digit numbers directly.
                // If y_height can exceed 9, truncate or pad manually
                defmt_write!(fmt, " {} |", y_height);
            }
        }
    }
}
