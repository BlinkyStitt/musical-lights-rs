#![no_std]
#![no_main]

use defmt::{info, warn};
use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};
use esp_backtrace as _;
use esp_hal::dma::{I2s0DmaChannel, Spi2DmaChannel};
use esp_hal::dma_buffers;
use esp_hal::gpio::{Level, Output, OutputConfig, Pin};
use esp_hal::i2s::master::{DataFormat, I2s, Standard};
use esp_hal::peripherals::{I2S0, SPI2};
use esp_hal::spi::master::{Config, Spi};
use esp_hal::time::Rate;
use esp_hal::timer::timg::TimerGroup;
use esp_hal::{clock::CpuClock, gpio::AnyPin};
use esp_println as _;
use musical_adafruit_sparkle::wheel;
use smart_leds::{brightness, SmartLedsWriteAsync, RGB8};
use ws2812_async::{Grb, Ws2812};

extern crate alloc;

const I2S_BYTES: usize = 4092;
const NUM_ONBOARD_NEOPIXELS: usize = 1;

#[embassy_executor::task]
async fn blink(pin: AnyPin) {
    let mut led = Output::new(pin, Level::Low, OutputConfig::default());

    loop {
        led.toggle();
        Timer::after_millis(200).await;
    }
}

/// TODO: how should we control the onboard neopixel? we need to use SPI
#[embassy_executor::task]
async fn blink_onboard_neopixel(spi: SPI2, pin: AnyPin, dma: Spi2DmaChannel) {
    let config = Config::default().with_frequency(Rate::from_hz(3_800_000));

    // config.phase = Phase::CaptureOnFirstTransition;
    // config.polarity = Polarity::IdleLow;

    // TODO: why can't this use SPI0 or SPI1?
    let spi = Spi::new(spi, config)
        .unwrap()
        .with_mosi(pin)
        // .with_dma(dma)
        .into_async();

    let mut ws: Ws2812<_, Grb, { 12 * NUM_ONBOARD_NEOPIXELS }> = Ws2812::new(spi);

    let mut data = [RGB8::default(); NUM_ONBOARD_NEOPIXELS];

    loop {
        for j in 0..(256 * 5) {
            (0..NUM_ONBOARD_NEOPIXELS).for_each(|i| {
                data[i] = wheel(
                    (((i * 256) as u16 / NUM_ONBOARD_NEOPIXELS as u16 + j as u16) & 255) as u8,
                );
            });

            ws.write(brightness(data.iter().cloned(), 16)).await.ok();

            Timer::after(Duration::from_millis(20)).await;
        }
    }
}

/// TODO: should this function take the transfer object instead? need 'static lifetimes for that to work
#[embassy_executor::task]
async fn i2s_mic_task(i2s: I2S0, dma: I2s0DmaChannel, bclk: AnyPin, ws: AnyPin, din: AnyPin) {
    // TODO: what size should these be?
    // TODO: the example has these flipped. we should fix the docs
    let (rx_buffer, rx_descriptors, _, tx_descriptors) = dma_buffers!(4 * I2S_BYTES, 0);

    let i2s = I2s::new(
        i2s,
        Standard::Philips,
        DataFormat::Data16Channel16,
        Rate::from_hz(44100),
        dma,
        rx_descriptors,
        tx_descriptors,
    )
    // .with_mclk(mclk) // TODO: do we need this pin?
    .into_async();

    let i2s_rx = i2s.i2s_rx.with_bclk(bclk).with_ws(ws).with_din(din).build();

    let mut transfer = i2s_rx
        .read_dma_circular_async(rx_buffer)
        .expect("failed reading i2s dma circular");

    let mut rcv = [0u8; 5000];

    loop {
        let avail = transfer
            .available()
            .await
            .expect("i2s mic transfer available failed");

        transfer
            .pop(&mut rcv[..avail])
            .await
            .expect("i2s mic transfer pop failed");

        // TODO: do something with the received data
        info!("Received {} bytes", avail);
    }
}

#[esp_hal_embassy::main]
async fn main(spawner: Spawner) {
    // generator version: 0.3.1

    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());
    let peripherals = esp_hal::init(config);

    // TODO: what size should this be? do we actually need this much?
    esp_alloc::heap_allocator!(size: 72 * 1024);

    //
    // pretty names for all the pins
    //
    let red_led = peripherals.GPIO4;

    let i2s_mic = peripherals.I2S0;
    let i2s_mic_dma = peripherals.DMA_I2S0;

    let i2s_mic_data = peripherals.GPIO25;
    let i2s_mic_ws = peripherals.GPIO33;
    let i2s_mic_bclk = peripherals.GPIO26;

    let neopixel_int = peripherals.GPIO2;

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

    let cap_touch_jst = peripherals.GPIO27;

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

    // blink the onboard LED
    let blink_f = blink(red_led.degrade());

    // blink the onboard neopixel
    let blink_neopixel_f = blink_onboard_neopixel(
        peripherals.SPI2,
        neopixel_int.degrade(),
        peripherals.DMA_SPI2,
    );

    // read from the i2s mic
    let i2s_mic_f = i2s_mic_task(
        i2s_mic,
        i2s_mic_dma,
        i2s_mic_bclk.degrade(),
        i2s_mic_ws.degrade(),
        i2s_mic_data.degrade(),
    );

    // Start the tasks on core 0
    spawner.spawn(blink_f).unwrap();
    spawner.spawn(blink_neopixel_f).unwrap();
    spawner.spawn(i2s_mic_f).unwrap();

    // TODO: what should we spawn on core 1?

    // TODO: what should the main loop do?
    loop {
        info!("Hello world!");
        Timer::after(Duration::from_secs(1)).await;
    }

    // for inspiration have a look at the examples at https://github.com/esp-rs/esp-hal/tree/esp-hal-v1.0.0-beta.0/examples/src/bin
}
