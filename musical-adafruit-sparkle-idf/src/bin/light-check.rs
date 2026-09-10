//! Bench pattern: channel identity, monotonic ramps, white, then a timed pulse.
//! The application drive cap remains 128. This tool never calibrates by eye.
use esp_idf_svc::hal::peripherals::Peripherals;
use smart_leds::RGB8;
use smart_leds_trait::SmartLedsWrite;
use std::{
    iter::repeat_n,
    thread::sleep,
    time::{Duration, Instant},
};
use ws2812_esp32_rmt_driver::{driver::color::LedPixelColorImpl, LedPixelEsp32Rmt};
type Net<'a> = LedPixelEsp32Rmt<'a, RGB8, LedPixelColorImpl<3, 0, 1, 2, 255>>;
fn main() -> eyre::Result<()> {
    esp_idf_svc::sys::link_patches();
    let peripherals = Peripherals::take()?;
    let mut leds = Net::new(peripherals.pins.gpio22)?;
    for channel in 0..4 {
        for drive in (0..=128).step_by(8) {
            let pixel = RGB8::new(
                if channel == 0 || channel == 3 {
                    drive
                } else {
                    0
                },
                if channel == 1 || channel == 3 {
                    drive
                } else {
                    0
                },
                if channel == 2 || channel == 3 {
                    drive
                } else {
                    0
                },
            );
            println!("channel {channel}, raw drive {drive}, all 400 pixels");
            leds.write(repeat_n(pixel, 400))?;
            sleep(Duration::from_secs(1));
        }
        leds.write(repeat_n(RGB8::default(), 400))?;
        sleep(Duration::from_secs(1));
    }
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        let on = start.elapsed().as_millis() % 1000 < 100;
        let drive = if on { 128 } else { 0 };
        leds.write(repeat_n(RGB8::new(drive, drive, drive), 400))?;
        sleep(Duration::from_millis(10));
    }
    leds.write(repeat_n(RGB8::default(), 400))?;
    Ok(())
}
