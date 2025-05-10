#![feature(type_alias_impl_trait)]

// use embassy_time::{Duration, Timer};
use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{gpio::OutputPin, prelude::Peripherals, rmt::RmtChannel, task::block_on},
    timer::EspTaskTimerService,
};
use esp_idf_sys::esp_random;
use smart_leds::hsv::{hsv2rgb, Hsv};
use smart_leds_trait::SmartLedsWrite;
use std::thread::sleep;
use std::time::Duration;
use ws2812_esp32_rmt_driver::Ws2812Esp32Rmt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // It is necessary to call this function once. Otherwise some patches to the runtime
    // implemented by esp-idf-sys might not link properly. See https://github.com/esp-rs/esp-idf-template/issues/71
    esp_idf_svc::sys::link_patches();

    // Bind the log crate to the ESP Logging facilities
    esp_idf_svc::log::EspLogger::initialize_default();

    log::info!("Hello, world!");

    let peripherals = Peripherals::take()?;
    let pins = peripherals.pins;
    let sysloop = EspSystemEventLoop::take();
    let timer_service = EspTaskTimerService::new()?;

    let neopixel_int = pins.gpio2;

    let mut ws2812 = Ws2812Esp32Rmt::new(peripherals.rmt.channel0, neopixel_int).unwrap();

    println!("Start NeoPixel rainbow!");

    let mut hue = unsafe { esp_random() } as u8;
    loop {
        let pixels = std::iter::repeat(hsv2rgb(Hsv {
            hue,
            sat: 255,
            val: 8,
        }))
        .take(25);
        ws2812.write(pixels).unwrap();

        sleep(Duration::from_millis(100));

        hue = hue.wrapping_add(10);
    }

    // block_on(async_main())
}

// async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
//     // TODO: select between a bunch of tasks? spawn them? not sure how to do that without embassy

//     loop {
//         log::info!("Hello, async world!");
//         Timer::after(Duration::from_secs(1)).await;
//     }
// }
