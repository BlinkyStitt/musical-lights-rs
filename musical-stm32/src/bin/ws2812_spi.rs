//! neopixel test
#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

use embassy_executor::Spawner;
use embassy_stm32::{
    gpio::{Level, Output, Speed},
    spi::{Config as SpiConfig, Spi},
    time::mhz,
};
use embassy_time::Timer;
use musical_lights_core::logging::info;
use smart_leds_trait::RGB8;
use {defmt_rtt as _, panic_probe as _};

const MATRIX_X: u32 = 32;
const MATRIX_Y: u32 = 8;

const MATRIX_N: usize = MATRIX_X as usize * MATRIX_Y as usize;
const MATRIX_BUFFER: usize = MATRIX_N * 12;

#[embassy_executor::task]
pub async fn blink_task(mut led: Output<'static>) {
    loop {
        info!("high");
        led.set_high();
        Timer::after_millis(1000).await;

        info!("low");
        led.set_low();
        Timer::after_millis(1000).await;
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let peripheral_config = Default::default();

    let p = embassy_stm32::init(peripheral_config);

    info!("Hello World!");

    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low);

    // start an async task in the background so that we can test the async part of the leds actually works properly
    spawner.must_spawn(blink_task(onboard_led));

    let mut spi_config = SpiConfig::default();

    // to work with ws2812 over SPI, spi_config.frequency must be >2 and <3.8
    spi_config.frequency = mhz(38) / 10u32; // 3.8MHz

    let spi_peri = p.SPI1;
    let mosi = p.PB5;
    let txdma = p.DMA2_CH2;

    let spi = Spi::new_txonly_nosck(spi_peri, mosi, txdma, spi_config);

    let mut neopixel = ws2812_async::Ws2812::<_, MATRIX_BUFFER>::new(spi);

    static BLANK: [RGB8; MATRIX_N] = [RGB8::new(0, 0, 0); MATRIX_N];

    neopixel.write(BLANK.iter().copied()).await.unwrap();
    Timer::after_secs(1).await;

    // 1 red, 1 black, 2 green, 1 black, 3 blue, 1 red, 1 green, 1 blue, 1 white, 1 black
    static TEST_PATTERN: [RGB8; 14] = [
        // 1 red
        RGB8::new(255, 0, 0),
        // 1 black
        RGB8::new(0, 0, 0),
        // 2 green
        RGB8::new(0, 255, 0),
        RGB8::new(0, 255, 0),
        // 1 black
        RGB8::new(0, 0, 0),
        // 3 blue
        RGB8::new(0, 0, 255),
        RGB8::new(0, 0, 255),
        RGB8::new(0, 0, 255),
        // 1 black
        RGB8::new(0, 0, 0),
        // 1 red
        RGB8::new(255, 0, 0),
        // 1 green
        RGB8::new(0, 255, 0),
        // 1 blue
        RGB8::new(0, 0, 255),
        // 1 white
        RGB8::new(255, 255, 255),
        // 1 black
        RGB8::new(0, 0, 0),
    ];

    // TODO: brightness and gamma correction!

    // TODO: loop to rotate this wheel
    neopixel
        .write(RbgToGrb {
            iter: TEST_PATTERN.iter().copied(),
        })
        .await
        .unwrap();
    Timer::after_secs(3).await;

    static FULL_PATTERN: [RGB8; 8 * 32] = [RGB8::new(32, 32, 32); 8 * 32];

    neopixel
        .write(RbgToGrb {
            iter: FULL_PATTERN.iter().copied(),
        })
        .await
        .unwrap();
    Timer::after_secs(3).await;

    // TODO: scroll a rainbow instead of full white

    info!("all tasks started");
}

/// https://github.com/smart-leds-rs/ws2812-spi-rs/issues/7
pub struct RbgToGrb<I> {
    iter: I,
}

impl<I> Iterator for RbgToGrb<I>
where
    I: Iterator<Item = RGB8>,
{
    type Item = RGB8;

    fn next(&mut self) -> Option<RGB8> {
        self.iter.next().map(|a| RGB8 {
            r: a.g,
            g: a.r,
            b: a.b,
        })
    }
}
