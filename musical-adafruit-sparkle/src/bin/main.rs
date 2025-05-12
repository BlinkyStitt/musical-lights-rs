//! TODO: i think the executor tasks should take the specific pins/peripherials. then it should call a generic function that takes AnyPin

#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]
#![no_std]
#![no_main]
// these warnings are annoying during initial dev. these things will be used soon
#![allow(unused_imports, unused)]

use alloc::boxed::Box;
use alloc::vec;
use defmt::{error, info, warn};
use embassy_executor::Spawner;
use embassy_time::{Duration, Ticker, Timer};
use esp_backtrace as _;
use esp_hal::dma::{I2s0DmaChannel, Spi2DmaChannel, Spi3DmaChannel};
use esp_hal::gpio::{Level, Output, OutputConfig, Pin};
use esp_hal::i2c::master::I2c;
use esp_hal::i2s::master::{DataFormat, I2s, Standard};
use esp_hal::peripherals::{I2C0, I2S0, SPI2, SPI3};
use esp_hal::rmt::Rmt;
use esp_hal::spi::master::{Config, Spi};
use esp_hal::{dma_buffers, dma_circular_buffers, dma_circular_descriptors};
// use esp_hal::spi::master::{Config, Spi};
use esp_hal::time::Rate;
use esp_hal::timer::timg::TimerGroup;
use esp_hal::{clock::CpuClock, gpio::AnyPin};
use esp_hal_smartled::{smartLedBuffer, SmartLedsAdapter};
use esp_println as _;
use lsm9ds1::interface::{I2cInterface, SpiInterface};
use musical_adafruit_sparkle::fps::FpsTracker;
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    SmartLedsWrite, RGB8,
};

extern crate alloc;

/// TODO: how fast? lets see how fast the hardware can go. we don't want to give anyone a headache or seizure though!
const FPS: u64 = 30;
/// TODO: why is this 4092? the docs say 4092 and 4096 gets weirds results. but why? what am I missing about i2s?
const I2S_BYTES: usize = 4092;
const NUM_ONBOARD_NEOPIXELS: usize = 1;
const NUM_FIBONACCI_NEOPIXELS: usize = 256;

const ONBOARD_BRIGHTNESS: u8 = 10;

/// 10% brightness is 25 out of 255. this is arbitrary
/// TODO: we have 5 Amps max. 256 leds at 20mA is 5.12A. max white is 60mA. limit to 82/255 to be extra cautious. these are bright even then.
const FIBONACCI_BRIGHTNESS: u8 = 25;

/// TODO: what size should these be?
/// TODO: I'm sometimes seeing "late" errors. i think this is because the buffer is too small. but i thought a circular buffer would keep it working
/// TODO: i can't make it bigger than this because the esp32 is too small. need to get this into external ram
const I2S_BUFFER_SIZE: usize = 3 * I2S_BYTES;

#[embassy_executor::task]
async fn blink_onboard(led: AnyPin) {
    let mut led = Output::new(led, Level::Low, OutputConfig::default());
    let mut ticker = Ticker::every(Duration::from_secs(1));

    loop {
        info!("Hello world!");
        led.toggle();
        ticker.next().await;
    }
}

/// blink the onboard neopixel and the fibonacci neopixels
#[embassy_executor::task]
async fn blink_fibonacci256_neopixel_rmt(
    onboard_rmt_channel: esp_hal::rmt::ChannelCreator<esp_hal::Blocking, 0>,
    onboard_pin: AnyPin,
    fibonacci_rmt_channel: esp_hal::rmt::ChannelCreator<esp_hal::Blocking, 1>,
    fibonacci_pin: AnyPin,
) {
    // TODO: why can't we use the NUM_ONBOARD_NEOPIXELS const here? that's sad
    let onboard_rmt_buffer: [u32; NUM_ONBOARD_NEOPIXELS * 24 + 1] = smartLedBuffer!(1);
    let fibonacci_rmt_buffer: [u32; NUM_FIBONACCI_NEOPIXELS * 24 + 1] = smartLedBuffer!(256);

    let mut onboard_leds =
        SmartLedsAdapter::new(onboard_rmt_channel, onboard_pin, onboard_rmt_buffer);
    let mut fibonacci_leds =
        SmartLedsAdapter::new(fibonacci_rmt_channel, fibonacci_pin, fibonacci_rmt_buffer);

    // TODO: everything under this should be in a separate function

    let mut base_hsv = Hsv {
        hue: 0,
        sat: 255,
        val: 255,
    };

    // TODO: make these static mut with #[link_section = ".ext_ram.bss"]  ?
    // let mut onboard_data: [RGB8; NUM_ONBOARD_NEOPIXELS];
    // let mut fibonacci_data: [_; NUM_FIBONACCI_NEOPIXELS];

    let mut base_rgb: [RGB8; 1] = [RGB8::default(); NUM_ONBOARD_NEOPIXELS];

    // TODO: i think we might want to just tie to the microphone output. might as well go at that rate
    let mut ticker = Ticker::every(Duration::from_nanos(1_000_000_000 / FPS));

    // TODO: only track fps in debug mode. make this a feature flag
    let mut fps = FpsTracker::new();

    // // TODO: how do we have this be a compile time check?
    // assert!(FIBONACCI_BRIGHTNESS < 81);

    loop {
        // loop over the full range of hues
        for hue in 0..=255 {
            fps.tick();

            info!("hue: {}", hue);

            base_hsv.hue = hue;

            // Convert from the HSV color space (where we can easily transition from one
            // color to the other) to the RGB color space that we can then send to the LED
            // TODO: increment the hue by 1 for every pixel
            // TODO: support palletes
            base_rgb[0] = hsv2rgb(base_hsv);

            // When sending to the LED, we do a gamma correction first (see smart_leds
            // documentation for details) and then limit the brightness to 10 out of 255 so
            // that the output it's not too bright.
            // TODO: fastled had cool dithering. can we use that here?
            // TODO: don't just change the color. use a fade effect to go from one color to the next
            // TODO: global brightness value that can change based on the capacitive touch sensor
            onboard_leds
                .write(brightness(
                    gamma(base_rgb.iter().copied()),
                    ONBOARD_BRIGHTNESS,
                ))
                .expect("onboard_leds write failed");

            // TODO: lots of different ways to do patterns here. this is just a simple color wheel that looks nice enough.
            // TODO: make it easy to remap the locations to indices. the layout is a nice spiral, but for a clock i need it by x/y
            fibonacci_leds
                .write(brightness(
                    gamma(
                        [base_hsv]
                            .iter()
                            .cycle()
                            .copied()
                            .enumerate()
                            .take(NUM_FIBONACCI_NEOPIXELS)
                            .map(|(i, mut x)| {
                                x.hue = x.hue.wrapping_add((i / 2) as u8);
                                hsv2rgb(x)
                            }),
                    ),
                    FIBONACCI_BRIGHTNESS,
                ))
                .expect("fibonacci_leds write failed");

            ticker.next().await;

            // TODO: log the framerate
        }
    }
}

#[embassy_executor::task]
async fn radio_task(spi: SPI2, _dma: Spi2DmaChannel) {
    let mut radio = sx1262::Device::new(spi);

    // TODO: everything under this should be in a separate function
    warn!("what should the radio loop do?");
}

// TODO: are we sure want I2C0 and not I2C1? or even SPI?
#[embassy_executor::task]
async fn accelerometer_task(i2c: I2C0, scl: AnyPin, sda: AnyPin) {
    // async fn accelerometer_task(spi: SPI3, ag_cs: AnyPin, m_cs: AnyPin) {
    // TODO: do we need to upgrade this library to support the magnetometer over i2c
    // TODO: what frequency?
    // let spi = Spi::new(spi, Config::default().with_frequency(frequency::Mhz(8)));
    // let spi_interface = SpiInterface::init(spi, ag_cs, m_cs);

    // TODO: what frequency?
    // TODO: support async i2c?
    let i2c = I2c::new(i2c, Default::default())
        .expect("failed to create i2c")
        .with_scl(scl)
        .with_sda(sda);

    let i2c_interface = I2cInterface::init(
        i2c,
        lsm9ds1::interface::i2c::AgAddress::_1,
        lsm9ds1::interface::i2c::MagAddress::_1,
    );

    let mut lsm = lsm9ds1::LSM9DS1Init {
        accel: Default::default(),
        gyro: Default::default(),
        mag: Default::default(),
    }
    .with_interface(i2c_interface);

    // TODO: have an interrupt?

    // TODO: how should we handle errors here? it shouldn't be fatal. we should still get blinkly lights of some kind
    if let Err(err) = lsm.begin_accel() {
        error!("failed to begin accelerometer");
    };
    if let Err(err) = lsm.begin_gyro() {
        error!("failed to begin gyro");
    };
    if let Err(err) = lsm.begin_mag() {
        error!("failed to begin magnetometer");
    };

    // TODO: everything under this should be in a separate function
    warn!("what should the accelerometer loop do?");
}

/// The ICS-43434 incorporates a high-pass filter to remove DC and low frequency components.
/// This high pass filter has a −3 dB corner frequency of 24 Hz and does not scale with the sampling rate.
///
/// TODO: should this function take the transfer object instead? need 'static lifetimes for that to work
#[embassy_executor::task]
async fn mic_task(i2s: I2S0, dma: I2s0DmaChannel, bclk: AnyPin, ws: AnyPin, din: AnyPin) {
    // TODO: how do we get this to be in the external ram?
    // TODO: the example has rx and tx flipped. we should fix the docs since that did not work
    // TODO: the example uses dma_buffers, but it feels like circular buffers are the right things to use here
    let (rx_buffer, rx_descriptors, tx_buffer, tx_descriptors) = dma_buffers!(I2S_BUFFER_SIZE, 0);

    // TODO: create the circular discriptors and the buffers indipendently because we want them to be in the external ram
    // let rx_buffer: Box<[u8]> = Box::new([0u8; I2S_BUFFER_SIZE]);  // TODO: this isn't write, but something like this should work
    // let (rx_descriptors, _, tx_descriptors) = dma_circular_descriptors!(I2S_BUFFER_SIZE, 0);

    // TODO: low power mode on the i2s?
    // TODO: if we want to sample at 48kHz, we probably want this on another core. writing the lights is blocking
    let i2s = I2s::new(
        i2s,
        Standard::Philips, // TODO: is this the right standard?
        // DataFormat::Data32Channel32, // TODO: this might be too much data
        DataFormat::Data16Channel16,
        // Rate::from_hz(48_000), // TODO: this is probably more than we need, but lets see what we can get out of this hardware
        Rate::from_hz(44_100), // TODO: this is probably more than we need, but lets see what we can get out of this hardware
        dma,
        rx_descriptors,
        tx_descriptors,
    )
    // .with_mclk(mclk) // TODO: do we need this pin? its the master clock output pin.
    .into_async();

    let i2s_rx = i2s.i2s_rx.with_bclk(bclk).with_ws(ws).with_din(din).build();

    let mut transfer = i2s_rx
        .read_dma_circular_async(rx_buffer)
        .expect("failed reading i2s dma circular");

    // TODO: should this be I2S_BYTES, or I2S_BUFFER_SIZE?
    // TODO: some example code had 5000 here. i don't know why it would need to be 4 bytes larger?
    let mut rcv: Box<[u8]> = Box::new([0u8; 5000]);

    loop {
        match transfer.available().await {
            Ok(mut avail) => {
                if (avail > rcv.len()) {
                    warn!("dropping some of the bytes");
                    avail = rcv.len();
                }

                transfer
                    .pop(&mut rcv[..avail])
                    .await
                    .expect("i2s mic transfer pop failed");

                // TODO: read this in chunks. we want to store it in a circular buffer so that we can do a windowing function on it
                // TODO: do something real with the data.
                // let sum = rcv.iter().map(|x| *x as u32).sum::<u32>();

                // TODO: do something with the received data
                info!("Received {} bytes", avail);
            }
            Err(e) => {
                error!("Error receiving data");

                // TODO: how do we force a restart?
                break;
            }
        }
    }
}

#[esp_hal_embassy::main]
async fn main(spawner: Spawner) {
    // generator version: 0.3.1

    // TODO: watchdog?
    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());

    // TODO: how do we configure the logger? i want timestamps

    let peripherals = esp_hal::init(config);

    // TODO: what size should this be? do we actually need this much?
    esp_alloc::heap_allocator!(size: 72 * 1024);

    //
    // pretty names for all the pins
    //

    // SPI0 is entirely dedicated to the flash cache the ESP32 uses to map the SPI flash device it is connected to into memory.
    let _ = peripherals.SPI0;
    // SPI1 is connected to the same hardware lines as SPI0 and is used to write to the flash chip.
    let _ = peripherals.SPI1;

    let red_led = peripherals.GPIO4;

    let i2s_mic = peripherals.I2S0;
    let i2s_mic_dma = peripherals.DMA_I2S0;

    let i2s_mic_data = peripherals.GPIO25;
    let i2s_mic_ws = peripherals.GPIO33;
    let i2s_mic_bclk = peripherals.GPIO26;

    let neopixel_builtin = peripherals.GPIO2;

    let neopixel_ext1 = peripherals.GPIO21;
    let neopixel_ext2 = peripherals.GPIO22;
    let neopixel_ext3 = peripherals.GPIO19;
    // you can also use the "output5v" as a fourth neopixel line

    // Connect to the RX pin found on a breakout or device.
    let uart_tx = peripherals.GPIO9;

    // Connect to the TX pin found on a breakout or device
    let uart_rx = peripherals.GPIO10;

    // This is a 5V level shifted output only! You can use it as another LED strip pin
    let output5v = peripherals.GPIO23;

    let whatever = peripherals.GPIO18;

    // This does NOT work if you use wifi
    let _cap_touch_jst = peripherals.GPIO27;

    // This JST SH 4-pin STEMMA QT connector breaks out I2C (SCL, SDA, 3.3V, GND)
    let i2c_scl = peripherals.GPIO13;
    let i2c_sda = peripherals.GPIO14;

    // Simply set it to be an input with a pullup.
    // This button can also be used to put the board into ROM bootloader mode.
    // To enter ROM bootloader mode, hold down boot button while clicking reset button mentioned above.
    // When in the ROM bootloader, you can upload code and query the chip using esptool.
    let boot_button = peripherals.GPIO0;

    // the ir received is connected to ADC1
    let ir_receiver = peripherals.GPIO32;

    //
    // end pretty names for all the pins
    //

    // initialize embassy
    let timer0 = TimerGroup::new(peripherals.TIMG1);
    esp_hal_embassy::init(timer0.timer0);
    info!("Embassy initialized!");

    let blink_onboard_f = blink_onboard(boot_button.degrade());

    // TODO: 80MHz is cargo culted. need to find the docs for this
    let rmt = Rmt::new(peripherals.RMT, Rate::from_mhz(80)).expect("initializing rmt");
    // // TODO: Async depends on <https://github.com/esp-rs/esp-hal-community/pull/6>
    // .into_async();

    let blink_fibonacci_f = blink_fibonacci256_neopixel_rmt(
        rmt.channel0,
        neopixel_builtin.degrade(),
        rmt.channel1,
        neopixel_ext2.degrade(),
    );

    // read from the i2s mic
    // TODO: how should we send the data to another task to be processed?
    let i2s_mic_f = mic_task(
        i2s_mic,
        i2s_mic_dma,
        i2s_mic_bclk.degrade(),
        i2s_mic_ws.degrade(),
        i2s_mic_data.degrade(),
    );

    let radio_f = radio_task(peripherals.SPI2, peripherals.DMA_SPI2);

    // TODO: should the accelerometer use SPI or I2C?
    // TODO: the lsm9ds1 crate docs say they don't support the i2c magnetometer. also, i've heard that i2c is bad and spi is better from smart people
    let accelerometer_f =
        accelerometer_task(peripherals.I2C0, i2c_scl.degrade(), i2c_sda.degrade());

    // Start the tasks on core 0
    spawner
        .spawn(blink_onboard_f)
        .expect("spawned blink onboard");
    spawner
        .spawn(blink_fibonacci_f)
        .expect("spawned blink_fibonacci");
    spawner.spawn(i2s_mic_f).expect("spawned i2s mic");
    spawner.spawn(radio_f).expect("spawned radio");
    spawner
        .spawn(accelerometer_f)
        .expect("spawned accelerometer");

    // TODO: what should we spawn on core 1?

    // TODO: should there be a main loop here? i think cpu monitoring sounds interesting

    // for inspiration have a look at the examples at https://github.com/esp-rs/esp-hal/tree/esp-hal-v1.0.0-beta.0/examples/src/bin
}
