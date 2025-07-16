//! Use a bank of filters for audio processing.
//!
//! An alternative to the code in [`BufferedFFT`].
//!
//! My original design (inspired by things built with a Teensy Audio Board) used an FFT.
//!

pub struct FilterBank<const N: usize> {
    filters: [(); N],
}
