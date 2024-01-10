//! # Use ws2812 leds via embassy spi
//!
//! - For usage with `smart-leds`
//! - Implements the `SmartLedsWrite` trait
//!
//! Needs a type implementing the `embedded_hal_async::SpiBus` trait.
//!
//! The spi peripheral should run at 2MHz to 3.8 MHz
//!
//! Forked from <https://github.com/smart-leds-rs/ws2812-spi-rs/commit/10ab8eb87935b1a8ed018ac939b10279e7a93ea1>.
//!
//! TODO: make this more general and then put it in its own crate

// Timings for ws2812 from https://cpldcpu.files.wordpress.com/2014/01/ws2812_timing_table.png
// Timings for sk6812 from https://cpldcpu.wordpress.com/2016/03/09/the-sk6812-another-intelligent-rgb-led/

use core::marker::PhantomData;

use embassy_stm32::spi::{self, Spi};
use smart_leds::{SmartLedsWrite, RGB8};

pub mod devices {
    /// AKA neopixels
    pub struct Ws2812;
    /// RGBW. placeholder. not implemented
    pub struct Sk6812w;
}

pub struct Ws2812<'a, PERI: spi::Instance, TX, RX, DEVICE = devices::Ws2812> {
    spi: Spi<'a, PERI, TX, RX>,
    device: PhantomData<DEVICE>,
}

impl<'a, PERI: spi::Instance, TX, RX> Ws2812<'a, PERI, TX, RX> {
    /// Use ws2812 devices via spi
    ///
    /// The SPI bus should run within 2 MHz to 3.8 MHz
    ///
    /// You may need to look at the datasheet and your own hal to verify this.
    ///
    /// Please ensure that the mcu is pretty fast, otherwise weird timing
    /// issues will occur
    ///
    /// TODO: this should be a write-only Spi
    pub fn new(spi: Spi<'a, PERI, TX, RX>) -> Self {
        Self {
            spi,
            device: PhantomData {},
        }
    }
}

// impl<'a, PERI: spi::Instance, TX, RX> Ws2812<'a, PERI, TX, RX, devices::Sk6812w> {
//     /// Use sk6812w devices via spi
//     ///
//     /// The SPI bus should run within 2.3 MHz to 3.8 MHz at least.
//     ///
//     /// You may need to look at the datasheet and your own hal to verify this.
//     ///
//     /// Please ensure that the mcu is pretty fast, otherwise weird timing
//     /// issues will occur
//     // The spi frequencies are just the limits, the available timing data isn't
//     // complete
//     pub fn new_sk6812w(spi: Spi<'a, PERI, TX, RX>) -> Self {
//         Self {
//             spi,
//             device: PhantomData {},
//         }
//     }
// }

impl<'a, PERI: spi::Instance, TX, RX, D> Ws2812<'a, PERI, TX, RX, D> {
    /// Write a single byte for ws2812 devices
    /// TODO: i don't think our E is generic. it probably should be though
    fn write_byte(&mut self, mut data: u8) -> Result<(), spi::Error> {
        // Send two bits in one spi byte. High time first, then the low time
        // The maximum for T0H is 500ns, the minimum for one bit 1063 ns.
        // These result in the upper and lower spi frequency limits
        // TODO: i do not understand this at all
        const PATTERNS: [u8; 4] = [0b1000_1000, 0b1000_1110, 0b11101000, 0b11101110];

        for _ in 0..4 {
            let bits = (data & 0b1100_0000) >> 6;
            self.spi.blocking_write(&[PATTERNS[bits as usize]])?;
            data <<= 2;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), spi::Error> {
        // Should be > 300μs, so for an SPI Freq. of 3.8MHz, we have to send at least 1140 low bits or 140 low bytes
        // TODO: set the N based on actual frequency
        self.spi.blocking_write(&[0u8; 140])?;

        Ok(())
    }
}

impl<'a, PERI: spi::Instance, TX, RX, D> SmartLedsWrite for Ws2812<'a, PERI, TX, RX, D> {
    type Error = spi::Error;
    type Color = RGB8;

    /// Write all the items of an iterator to a ws2812 strip
    fn write<T, I>(&mut self, iterator: T) -> Result<(), Self::Error>
    where
        T: Iterator<Item = I>,
        I: Into<Self::Color>,
    {
        // We introduce an offset in the fifo here, so there's always one byte in transit
        // Some MCUs (like the stm32f1) only a one byte fifo, which would result
        // in overrun error if two bytes need to be stored
        self.spi.blocking_write(&[0u8])?;

        if cfg!(feature = "mosi_idle_high") {
            self.flush()?;
        }

        for item in iterator {
            let color = item.into();
            self.write_byte(color.g)?;
            self.write_byte(color.r)?;
            self.write_byte(color.b)?;
        }
        self.flush()?;

        // Now, resolve the offset we introduced at the beginning
        // self.spi.blocking_read()?;

        Ok(())
    }
}

// impl<'a, PERI, TX, RX, E> SmartLedsWrite for Ws2812<'a, PERI, TX, RX, devices::Sk6812w> {
//     type Error = E;
//     type Color = RGBW<u8, u8>;
//     /// Write all the items of an iterator to a ws2812 strip
//     fn write<T, I>(&mut self, iterator: T) -> Result<(), E>
//     where
//         T: Iterator<Item = I>,
//         I: Into<Self::Color>,
//     {
//         // We introduce an offset in the fifo here, so there's always one byte in transit
//         // Some MCUs (like the stm32f1) only a one byte fifo, which would result
//         // in overrun error if two bytes need to be stored
//         block!(self.spi.send(0))?;
//         if cfg!(feature = "mosi_idle_high") {
//             self.flush()?;
//         }

//         for item in iterator {
//             let color = item.into();
//             self.write_byte(color.g)?;
//             self.write_byte(color.r)?;
//             self.write_byte(color.b)?;
//             self.write_byte(color.a.0)?;
//         }
//         self.flush()?;
//         // Now, resolve the offset we introduced at the beginning
//         block!(self.spi.read())?;
//         Ok(())
//     }
// }
