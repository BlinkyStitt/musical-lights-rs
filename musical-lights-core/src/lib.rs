#![cfg_attr(test, feature(iter_next_chunk))]
#![cfg_attr(not(feature = "std"), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(all(test, not(feature = "std")))]
#[macro_use]
extern crate std;

pub mod audio;
pub mod battery;
pub mod compass;
pub mod config;
pub mod errors;
#[cfg(any(feature = "std", feature = "embassy"))]
pub mod fps;
pub mod gps;
pub mod iter;
pub mod lights;
pub mod logging;
pub mod message;
pub mod orientation;
pub mod radio;
pub mod sd;
pub mod speaker;
pub mod windows;

/// Map t in range [a, b] to range [c, d]
/// TODO: remap for u8 and u16
/// TODO: make the clamp optional?
#[inline(always)]
pub const fn remap(t: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
    let x = (t - a) * ((d - c) / (b - a)) + c;
    x.clamp(c, d)
}
