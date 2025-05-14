#![feature(future_join)]
#![feature(type_alias_impl_trait)]

use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{
        gpio::{AnyInputPin, AnyOutputPin, InputPin, OutputPin},
        i2s::I2S0,
        prelude::Peripherals,
    },
    timer::EspTaskTimerService,
};
use esp_idf_sys::{esp_get_free_heap_size, esp_random};
use log::info;
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    RGB8,
};
use smart_leds_trait::SmartLedsWrite;
use std::thread::{self, sleep};
use std::{thread::yield_now, time::Duration};
use ws2812_esp32_rmt_driver::Ws2812Esp32Rmt;

const NUM_ONBOARD_NEOPIXELS: usize = 1;
const NUM_FIBONACCI_NEOPIXELS: usize = 256;
const I2S_BUFFER_SIZE: usize = 4092 * 12;
const FPS: u64 = 90;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // It is necessary to call this function once. Otherwise some patches to the runtime
    // implemented by esp-idf-sys might not link properly. See https://github.com/esp-rs/esp-idf-template/issues/71
    esp_idf_svc::sys::link_patches();

    // Bind the log crate to the ESP Logging facilities
    esp_idf_svc::log::EspLogger::initialize_default();

    info!("Hello, world!");

    let peripherals = Peripherals::take()?;
    let pins = peripherals.pins;
    let sysloop = EspSystemEventLoop::take();
    let timer_service = EspTaskTimerService::new()?;

    // TODO: VSPI for the external neopixels
    // TODO: HSPI for the sensors

    // let (rx_buffer, rx_descriptors, tx_buffer, tx_descriptors) =
    //     dma_circular_buffers!(I2S_BUFFER_SIZE, 0);

    let mut neopixel_onboard = Ws2812Esp32Rmt::new(peripherals.rmt.channel0, pins.gpio2)?;

    // TODO: instead of RMT, lets use SPI. that can use DMA and so should be faster
    let mut neopixel_external = Ws2812Esp32Rmt::new(peripherals.rmt.channel1, pins.gpio4)?;

    let (audio_sample_tx, audio_sample_rx) = flume::bounded::<()>(4);

    // create all the futures
    // let blink_neopixels_f = blink_neopixels_task(&mut neopixel_onboard);

    // TODO: do we need two cores? how do we set them up?

    let free_memory = unsafe { esp_get_free_heap_size() } / 1024;

    // TODO: log this every 60 seconds?
    info!("Free memory: {free_memory}KB");

    // TODO: do these move across cores automatically? how do we spawn on a specific core?
    let blink_neopixels_handle = thread::spawn(move || {
        // TODO: how should we handle errors?
        blink_neopixels_task(&mut neopixel_onboard, &mut neopixel_external).unwrap();
    });

    let mic_handle = thread::spawn(move || {
        mic_task(
            peripherals.i2s0,
            pins.gpio25.downgrade_output(),
            pins.gpio26.downgrade_output(),
            pins.gpio27.downgrade_input(),
            audio_sample_tx,
        )
        .unwrap();
    });

    // TODO: this isn't very good. an error on the second child won't show until the first exits.
    // we want to pass errors around don't we? maybe we should use async tasks instead?
    blink_neopixels_handle.join().unwrap();
    mic_handle.join().unwrap();

    // // TODO: block on the futures joined together
    // let (x, y) = block_on(join!(blink_neopixels_f, mic_f));

    // x?;
    // y?;

    Ok(())
}

/// TODO: dithering! fastled looked so good with the dithering
fn blink_neopixels_task(
    neopixel_onboard: &mut Ws2812Esp32Rmt<'_>,
    neopixel_external: &mut Ws2812Esp32Rmt<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    info!("Start NeoPixel rainbow!");

    // TODO: initialize the wifi/bluetooth to get a true random number
    // TODO: initial hue from the gps' time so that the compasses are always in perfect sync
    let mut hue = unsafe { esp_random() } as u8;

    let mut onboard_data = Box::new([RGB8::default(); NUM_ONBOARD_NEOPIXELS]);
    let mut fibonacci_data = Box::new([RGB8::default(); NUM_FIBONACCI_NEOPIXELS]);

    loop {
        info!("Hue: {hue}");

        let base_hsv = Hsv {
            hue,
            sat: 255,
            val: 255,
        };

        onboard_data[0] = hsv2rgb(base_hsv);

        // TODO: iterator?
        for (i, x) in fibonacci_data.iter_mut().enumerate() {
            let mut y = base_hsv;

            y.hue = y.hue.wrapping_add((i / 2) as u8);

            *x = hsv2rgb(y);
        }

        neopixel_onboard.write(brightness(gamma(onboard_data.iter().cloned()), 8))?;
        neopixel_external.write(brightness(gamma(fibonacci_data.iter().cloned()), 16))?;

        sleep(Duration::from_nanos(1_000_000_000 / FPS));

        hue = hue.wrapping_add(1);
    }
}

fn mic_task(
    i2s: I2S0, /*dma: I2s0DmaChannel, */
    bclk: AnyOutputPin,
    ws: AnyOutputPin,
    din: AnyInputPin,
    audio_sample_tx: flume::Sender<()>,
) -> Result<(), Box<dyn std::error::Error>> {
    // TODO: the esp32-s3 can put the dma on external ram, but i don't think the esp32 can
    // <https://github.com/esp-rs/esp-hal/blob/main/examples/src/bin/spi_loopback_dma_psram.rs>
    // TODO: the example has rx and tx flipped. we should fix the docs since that did not work
    // TODO: the example uses dma_buffers, but it feels like circular buffers are the right things to use here
    // TODO: how do we make the buffer chunk size smaller? i think that would work better. we need it to be an amount that fits in the fft cleanly
    // let (rx_buffer, rx_descriptors, tx_buffer, tx_descriptors) =
    //     dma_circular_buffers!(I2S_BUFFER_SIZE, 0);

    // TODO: i don't understand how to make the chunk size smaller
    // let (rx_buffer, rx_descriptors, tx_buffer, tx_descriptors) =
    //     dma_buffer!(I2S_BUFFER_SIZE, 0, CHUNK_SIZE);

    /*
    // TODO: do we actually want async here? blocking is fine if this uses dma
    // TODO: low power mode on the i2s?
    // TODO: if we want to sample at 48kHz, we probably want this on another core. writing the lights is blocking
    let i2s = I2s::new(
        i2s,
        Standard::Philips, // TODO: is this the right standard?
        // DataFormat::Data32Channel32, // TODO: this might be too much data
        DataFormat::Data16Channel16,
        Rate::from_hz(48_000), // TODO: this is probably more than we need, but lets see what we can get out of this hardware
        // Rate::from_hz(44_100), // TODO: this is probably more than we need, but lets see what we can get out of this hardware
        // Rate::from_hz(16_000),
        dma,
        rx_descriptors,
        tx_descriptors,
    )
    // .with_mclk(mclk) // TODO: do we need this pin? its the master clock output pin.
    // .into_async();

    // TODO: set an interrupt handler?

    let i2s_rx = i2s.i2s_rx.with_bclk(bclk).with_ws(ws).with_din(din).build();

    // TODO: maybe we don't want a circular buffer. maybe we want to read with one shots?
    let mut transfer = i2s_rx
        .read_dma_circular_async(rx_buffer)
        .expect("failed reading i2s dma circular");

    // TODO: should this be I2S_BYTES, or I2S_BUFFER_SIZE?
    // TODO: some example code had 5000 here. i don't know why it would need to be larger?
    let mut rcv: Box<[u8]> = Box::new([0u8; I2S_BUFFER_SIZE]);
    let mut avail = 0;

    loop {
        avail = transfer.available().await?;

        transfer
            .pop(&mut rcv[..avail])
            .await
            .expect("i2s mic transfer pop failed");

        // TODO: read this in chunks. we want to store it in a circular buffer so that we can do a windowing function on it
        // TODO: do something real with the data.
        // let sum = rcv.iter().map(|x| *x as u32).sum::<u32>();

        // TODO: do something with the received data
        info!("{} bytes", avail);
    }
     */
    Ok(())
}
