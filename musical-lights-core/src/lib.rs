#![no_std]
#![cfg_attr(not(test), no_main)]
#![feature(type_alias_impl_trait)]

pub mod audio;
pub mod battery;
pub mod compass;
pub mod config;
pub mod gps;
pub mod lights;
pub mod logging;
pub mod orientation;
pub mod radio;
pub mod sd;
pub mod speaker;
pub mod windows;

/// Map t in range [a, b] to range [c, d]
/// TODO: remap for u8 and u16
pub fn remap(t: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
    (t - a) * ((d - c) / (b - a)) + c
}
