#![feature(future_join)]
#![feature(type_alias_impl_trait)]

mod fps;

use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{
        gpio::{AnyIOPin, Gpio25, Gpio26, Gpio27},
        i2s::{
            config::{DataBitWidth, StdConfig},
            I2sDriver, I2S0,
        },
        prelude::Peripherals,
    },
    timer::EspTaskTimerService,
};
use esp_idf_sys::{esp_get_free_heap_size, esp_random};
use log::{error, info};
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    RGB8,
};
use smart_leds_trait::SmartLedsWrite;
use std::thread::{self, sleep};
use std::time::Duration;
use ws2812_esp32_rmt_driver::Ws2812Esp32Rmt;

use fps::FpsTracker;

const NUM_ONBOARD_NEOPIXELS: usize = 1;
const NUM_FIBONACCI_NEOPIXELS: usize = 256;
/// TODO: this is probably too high once we have a bunch of other things going on. but lets try out two cores!
const FPS_FIBONACCI_NEOPIXELS: u64 = 100;
const I2S_SAMPLE_RATE_HZ: u32 = 48_000;
const FFT_SIZE: usize = 4096;

fn main() -> eyre::Result<()> {
    // It is necessary to call this function once. Otherwise some patches to the runtime
    // implemented by esp-idf-sys might not link properly. See https://github.com/esp-rs/esp-idf-template/issues/71
    esp_idf_svc::sys::link_patches();

    // Bind the log crate to the ESP Logging facilities
    esp_idf_svc::log::EspLogger::initialize_default();

    info!("Hello, world!");

    let peripherals = Peripherals::take()?;
    let pins = peripherals.pins;

    // TODO: use this for anything?
    let sysloop = EspSystemEventLoop::take();

    // TODO: use timer service instead of std sleep?
    let timer_service = EspTaskTimerService::new()?;

    // TODO: VSPI for the external neopixels?
    // TODO: HSPI for the sensors?

    let mut neopixel_onboard = Ws2812Esp32Rmt::new(peripherals.rmt.channel0, pins.gpio2)?;

    // TODO: instead of RMT, lets use SPI. that can use DMA and so should be faster
    let mut neopixel_external = Ws2812Esp32Rmt::new(peripherals.rmt.channel1, pins.gpio4)?;

    let (audio_sample_tx, audio_sample_rx) = flume::bounded::<()>(4);

    // create all the futures
    // let blink_neopixels_f = blink_neopixels_task(&mut neopixel_onboard);

    // TODO: do we need two cores? how do we set them up?

    let free_memory = unsafe { esp_get_free_heap_size() } / 1024;
    // let free_psram = unsafe { esp_psram_get_size() } / 1024;

    // TODO: log this every 60 seconds?
    info!("Free memory: {free_memory}KB");
    // info!("Free psram: {free_psram}KB");

    // TODO: how do we spawn on a specific core? though the spi driver should be able to use DMA
    let blink_neopixels_handle = thread::spawn(move || {
        if let Err(err) = blink_neopixels_task(&mut neopixel_onboard, &mut neopixel_external) {
            // TODO: how should we handle errors?
            error!("Error in blink neopixels task: {err}");
            panic!("Blink neopixels task failed");
        };
    });

    let mic_handle = thread::spawn(move || {
        if let Err(err) = mic_task(
            peripherals.i2s0,
            pins.gpio25,
            pins.gpio26,
            pins.gpio27,
            audio_sample_tx,
        ) {
            error!("Error in mic task: {err}");
            panic!("Mic task failed");
        };
    });

    // TODO: thread for monitoring ram/cpu/etc

    // TODO: an error on the second handle won't show until the first finishes.
    // we want to pass errors around don't we? maybe we should use async tasks instead?
    mic_handle.join().expect("mic thread panicked");
    blink_neopixels_handle
        .join()
        .expect("neopixel thread panicked");

    Ok(())
}

/// TODO: dithering! fastled looked so good with the dithering
fn blink_neopixels_task(
    neopixel_onboard: &mut Ws2812Esp32Rmt<'_>,
    neopixel_external: &mut Ws2812Esp32Rmt<'_>,
) -> eyre::Result<()> {
    info!("Start NeoPixel rainbow!");

    // TODO: initialize the wifi/bluetooth to get a true random number
    // TODO: initial hue from the gps' time so that the compasses are always in perfect sync
    let mut hue = unsafe { esp_random() } as u8;

    let mut onboard_data = Box::new([RGB8::default(); NUM_ONBOARD_NEOPIXELS]);
    let mut fibonacci_data = Box::new([RGB8::default(); NUM_FIBONACCI_NEOPIXELS]);

    let mut fps = FpsTracker::new();

    loop {
        info!("Hue: {hue}");

        let base_hsv = Hsv {
            hue,
            sat: 255,
            val: 255,
        };

        // TODO: gamme correct now?
        onboard_data[0] = hsv2rgb(base_hsv);

        // TODO: do a real pattern here
        for (i, x) in fibonacci_data.iter_mut().enumerate() {
            let mut new = base_hsv;

            new.hue = new.hue.wrapping_add((i / 2) as u8);

            *x = hsv2rgb(new);
        }

        neopixel_onboard.write(brightness(gamma(onboard_data.iter().cloned()), 8))?;
        neopixel_external.write(brightness(gamma(fibonacci_data.iter().cloned()), 16))?;

        fps.tick();

        sleep(Duration::from_nanos(
            1_000_000_000 / FPS_FIBONACCI_NEOPIXELS,
        ));

        hue = hue.wrapping_add(1);
    }
}

fn mic_task(
    i2s: I2S0, /*dma: I2s0DmaChannel, */
    bclk: Gpio25,
    ws: Gpio26,
    din: Gpio27,
    audio_sample_tx: flume::Sender<()>,
) -> eyre::Result<()> {
    info!("Start I2S mic!");

    // 24 bit audio is padded to 32 bits
    // TODO: do we want to use 8 or 16 bit audio?
    let i2s_config = StdConfig::philips(I2S_SAMPLE_RATE_HZ, DataBitWidth::Bits32);

    // TODO: do we want the mclk pin?
    let mut i2s_driver = I2sDriver::new_std_rx(i2s, &i2s_config, bclk, din, None::<AnyIOPin>, ws)?;

    i2s_driver.rx_enable()?;

    // TODO: what size should this buffer be? i'm really not sure what this data even looks like
    let mut i2s_buffer = Box::new([0u8; FFT_SIZE * size_of::<u32>()]);

    info!("I2S mic driver created");

    loop {
        // TODO: what should the timeout be?!?!
        // TODO: do we want async here? i wasn't sure what to set for the timeout on the sync read
        let bytes_read = i2s_driver.read(i2s_buffer.as_mut_slice(), 4)?;

        info!("Read {bytes_read} bytes from I2S mic");

        // TODO: actually do something with the audio samples. probably just process them here, but maybe use flume to another core
        // audio_sample_tx.send(())?;
    }
}
