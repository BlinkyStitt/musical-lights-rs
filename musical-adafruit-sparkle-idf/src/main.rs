#![feature(future_join)]
#![feature(type_alias_impl_trait)]

use biski64::Biski64Rng;
use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{
        delay::Delay,
        gpio::{AnyIOPin, Gpio25, Gpio26, Gpio27},
        i2s::{
            config::{DataBitWidth, StdConfig},
            I2sDriver, I2S0,
        },
        prelude::Peripherals,
        uart::{config::Config, UartDriver},
        units::Hertz,
    },
    nvs::EspDefaultNvsPartition,
    timer::EspTaskTimerService,
};
use esp_idf_sys::{
    bootloader_random_disable, bootloader_random_enable, esp_get_free_heap_size, esp_random,
};
use log::{error, info};
use musical_lights_core::fps::FpsTracker;
use musical_lights_core::message::MESSAGE_BAUD_RATE;
use rand::{RngCore, SeedableRng};
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    RGB8,
};
use smart_leds_trait::SmartLedsWrite;
use std::thread::{self, sleep};
use std::time::Duration;

// TODO: maybe use the spi driver instead? i'm not sure. rmt should be good. theres 8 channels and we only have 4 5v outputs. so lets stick with rmt for now
use ws2812_esp32_rmt_driver::Ws2812Esp32Rmt;

const NUM_ONBOARD_NEOPIXELS: usize = 1;
const NUM_FIBONACCI_NEOPIXELS: usize = 256;
/// TODO: this is probably too high once we have a bunch of other things going on. but lets try out two cores!
/// TODO: should this match our slowest sensor?
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

    // TODO: use this for anything? <https://github.com/esp-rs/esp-idf-svc/blob/master/examples/eventloop.rs>
    let sysloop = EspSystemEventLoop::take();

    // TODO: use timer service instead of std sleep?
    let timer_service = EspTaskTimerService::new()?;

    // TODO: do something with nvs. like set up signing keys
    let nvs = EspDefaultNvsPartition::take()?;

    // TODO: set up bluetooth or wifi. not sure what to do with them. but they give us a true rng

    let mut neopixel_onboard = Ws2812Esp32Rmt::new(peripherals.rmt.channel0, pins.gpio2)?;
    let mut neopixel_external = Ws2812Esp32Rmt::new(peripherals.rmt.channel1, pins.gpio22)?;

    let (audio_sample_tx, audio_sample_rx) = flume::bounded::<()>(4);

    // TODO: this baud rate needs to match the sensory board
    let uart1_config = Config::default().baudrate(Hertz(MESSAGE_BAUD_RATE));

    let uart1: UartDriver = UartDriver::new(
        peripherals.uart1,
        pins.gpio9,
        pins.gpio10,
        Option::<AnyIOPin>::None,
        Option::<AnyIOPin>::None,
        &uart1_config,
    )?;

    // you need `into_split` and not `split` so that the halves can be sent to different threads
    let (uart1_tx_driver, uart1_rx_driver) = uart1.into_split();

    // create all the futures
    // let blink_neopixels_f = blink_neopixels_task(&mut neopixel_onboard);

    // TODO: do we need two cores? how do we set them up?

    // for using randomness, we could also turn on the bluetooth or wifi modules, but I don't have a use for them currently
    let seed_high;
    let seed_low;
    unsafe {
        bootloader_random_enable();
        seed_high = esp_random();
        seed_low = esp_random();
        bootloader_random_disable()
    };

    let seed: u64 = ((seed_high as u64) << 32) | (seed_low as u64);

    // TODO: where should we use this rng?
    let mut rng_1 = Biski64Rng::from_seed_for_stream(seed, 0, 2);
    let mut rng_2 = Biski64Rng::from_seed_for_stream(seed, 1, 2);

    // TODO: how do we spawn on a specific core? though the spi driver should be able to use DMA
    let blink_neopixels_handle = thread::spawn(move || {
        blink_neopixels_task(&mut neopixel_onboard, &mut neopixel_external).inspect_err(|err| {
            error!("Error in blink_neopixels_task: {err}");
        })
    });

    // TODO: wait for a ping from the sensor board?

    let sensor_rx_handle = thread::spawn(move || {
        // TODO: wait for data from the sensor board. try not to lock
        uart1_rx_driver;

        Ok::<_, eyre::Report>(())
    });

    let sensor_tx_handle = thread::spawn(move || {
        // TODO: send data to the sensor board. try not to lock
        uart1_tx_driver;

        Ok::<_, eyre::Report>(())
    });

    let fft_handle = thread::spawn(move || {
        audio_sample_rx;

        Ok::<_, eyre::Report>(())
    });

    //
    let mic_handle = thread::spawn(move || {
        mic_task(
            peripherals.i2s0,
            pins.gpio25,
            pins.gpio26,
            pins.gpio27,
            audio_sample_tx,
        )
        .inspect_err(|err| {
            error!("Error in mic task: {err}");
        })
    });

    // TODO: debug-only thread for monitoring ram/cpu/etc?

    let mut handles = [
        Some(blink_neopixels_handle),
        Some(fft_handle),
        Some(mic_handle),
        Some(sensor_rx_handle),
        Some(sensor_tx_handle),
    ];

    // TODO: i don't really like this, but it works for now
    let mut num_taken = 0;
    let main_loop_delay = Delay::new(1_000_000);
    loop {
        for x in &mut handles {
            // TODO: why is take_if not available? it seems like it was working but rust analyzer was definitely confused
            if x.as_ref().is_some_and(|v| v.is_finished()) {
                x.take()
                    .expect("x was Some")
                    .join()
                    .expect("thread panicked")?;

                num_taken += 1;
            }
        }

        // log free memory every 60 seconds. only do this if we are in debug mode
        let free_memory = unsafe { esp_get_free_heap_size() } / 1024;
        info!("Free memory: {free_memory}KB");

        if num_taken == handles.len() {
            // TODO: this is actually unexpected. think more about this
            info!("All threads finished successfully!");
            break;
        } else {
            info!(
                "Waiting for {}/{} threads to finish...",
                handles.len() - num_taken,
                handles.len()
            );
        }

        // TODO: is this a good way to delay? it seems like theres a bunch of ways to set up timers/delays
        main_loop_delay.delay_ms(1_000);
    }

    Ok(())
}

/// TODO: dithering! fastled looked so good with the dithering
fn blink_neopixels_task(
    neopixel_onboard: &mut Ws2812Esp32Rmt<'_>,
    neopixel_external: &mut Ws2812Esp32Rmt<'_>,
) -> eyre::Result<()> {
    info!("Start NeoPixel rainbow!");

    // TODO: initialize the wifi/bluetooth to get a true random number. though it looks like with the esp32, we can't use i2s and the rng.
    // TODO: so we should set up the rng, get a true random number, then use that to seed a software rng like wyhash or chacha
    // TODO: initial hue from the gps' time so that the compasses are always in perfect sync
    // TODO: no. don't do this here. we need to read random at the start after we explictly enable it. then we should disable it. use that to seed a PRNG.
    let mut g_hue = 0;

    let mut onboard_data = Box::new([RGB8::default(); NUM_ONBOARD_NEOPIXELS]);
    let mut fibonacci_data = Box::new([RGB8::default(); NUM_FIBONACCI_NEOPIXELS]);

    // TODO: for onboard, we should display a test pattern. 1 red flash, then 2 green flashes, then 3 blue flashes, then 4 white flashes
    // TODO: for fibonacci, we should display a test pattern of 1 red, 1 blank, 2 green, 1 blank, 3 blue, 1 blank, then 4 whites. then whole panel red

    let mut fps = FpsTracker::new();

    loop {
        info!("Hue: {g_hue}");

        // TODO: Hsl instead of Hsv?
        let base_hsv = Hsv {
            hue: g_hue,
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

        // TODO: reading these from a buffer is probably better than doing any calculations in the iter. that takes more memory, but it works well
        // TODO: check that the gamma correction is what we need for our leds
        // TODO: dithering
        neopixel_onboard.write(brightness(gamma(onboard_data.iter().cloned()), 8))?;

        // TODO: brightness should be from the config
        neopixel_external.write(brightness(gamma(fibonacci_data.iter().cloned()), 16))?;

        fps.tick();

        sleep(Duration::from_nanos(
            1_000_000_000 / FPS_FIBONACCI_NEOPIXELS,
        ));

        g_hue = g_hue.wrapping_add(1);
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
