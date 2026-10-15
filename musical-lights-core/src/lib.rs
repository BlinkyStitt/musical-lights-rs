#![cfg_attr(test, feature(iter_next_chunk))]
#![cfg_attr(not(feature = "std"), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(all(test, not(feature = "std")))]
#[macro_use]
extern crate std;

pub mod amulet;
pub mod amulet_output;
pub mod audio;
pub mod battery;
pub mod clock;
pub mod compass;
pub mod config;
pub mod controller;
pub mod errors;
#[cfg(any(feature = "std", feature = "embassy"))]
pub mod fps;
pub mod gps;
pub mod iter;
pub mod lights;
pub mod logging;
pub mod message;
pub mod navigation;
pub mod orientation;
pub mod pattern_motion;
pub mod provisioning;
pub mod radio;
pub mod sd;
pub mod sensor_mount;
pub mod speaker;
pub mod storage;

/// Map t in range [a, b] to range [c, d]
/// TODO: remap for u8 and u16
/// TODO: make the clamp optional?
#[inline(always)]
pub const fn remap(t: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
    let x = (t - a) * ((d - c) / (b - a)) + c;
    x.clamp(c, d)
}

#[cfg(test)]
mod firmware_tests;
