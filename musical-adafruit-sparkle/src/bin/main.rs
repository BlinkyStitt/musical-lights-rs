#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]
#![no_std]
#![no_main]

use alloc::boxed::Box;
use alloc::vec;
use defmt::info;
use embassy_executor::Spawner;
use embassy_time::{Duration, Ticker};
use esp_backtrace as _;
use esp_hal::dma::I2s0DmaChannel;
use esp_hal::dma_buffers;
use esp_hal::gpio::{Level, Output, OutputConfig, Pin};
use esp_hal::i2s::master::{DataFormat, I2s, Standard};
use esp_hal::peripherals::I2S0;
use esp_hal::rmt::Rmt;
// use esp_hal::spi::master::{Config, Spi};
use esp_hal::time::Rate;
use esp_hal::timer::timg::TimerGroup;
use esp_hal::{clock::CpuClock, gpio::AnyPin};
use esp_hal_smartled::{smartLedBuffer, SmartLedsAdapter};
use esp_println as _;
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    SmartLedsWrite, RGB8,
};

extern crate alloc;

const I2S_BYTES: usize = 4092;
const NUM_ONBOARD_NEOPIXELS: usize = 1;
const NUM_FIBONACCI_NEOPIXELS: usize = 256;

/// TODO: maybe one task should blink both. that way we can share the hue without locking. and they will both definitely both use the same gHue.
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

    let mut g_color = Hsv {
        hue: 0,
        sat: 255,
        val: 255,
    };

    // TODO: make these static mut with #[link_section = ".ext_ram.bss"]  ?
    // let mut onboard_data: [RGB8; NUM_ONBOARD_NEOPIXELS];
    // let mut fibonacci_data: [_; NUM_FIBONACCI_NEOPIXELS];

    let mut onboard_data: Box<[RGB8]> = vec![RGB8::default()].into_boxed_slice();

    // 60 fps
    // TODO: i think we might want to just tie to the microphone output. might as well go at that rate
    let mut ticker = Ticker::every(Duration::from_micros(16_666));

    loop {
        // TODO: display the current g_color on the onboard neopixel for debugging

        // Iterate over the rainbow!
        for hue in 0..=255 {
            info!("hue: {}", hue);

            g_color.hue = hue;

            // Convert from the HSV color space (where we can easily transition from one
            // color to the other) to the RGB color space that we can then send to the LED
            // TODO: increment the hue by 1 for every pixel
            onboard_data[0] = hsv2rgb(g_color);
            // fibonacci_data = [color; NUM_FIBONACCI_NEOPIXELS];

            // When sending to the LED, we do a gamma correction first (see smart_leds
            // documentation for details) and then limit the brightness to 10 out of 255 so
            // that the output it's not too bright.
            // TODO: fastled had cool dithering. can we use that here?
            // TODO: don't just change the color. use a fade effect to go from one color to the next
            // TODO: global brightness value that can change based on the capacitive touch sensor
            onboard_leds
                .write(brightness(gamma(onboard_data.iter().cloned()), 10))
                .expect("onboard_leds write failed");

            fibonacci_leds
                .write(brightness(
                    gamma(
                        onboard_data
                            .iter()
                            .cycle()
                            .take(NUM_FIBONACCI_NEOPIXELS)
                            .cloned(),
                    ),
                    25,
                ))
                .expect("fibonacci_leds write failed");

            ticker.next().await;
        }
    }
}

/// TODO: should this function take the transfer object instead? need 'static lifetimes for that to work
#[embassy_executor::task]
async fn i2s_mic_task(i2s: I2S0, dma: I2s0DmaChannel, bclk: AnyPin, ws: AnyPin, din: AnyPin) {
    // TODO: what size should these be?
    // TODO: the example has these flipped. we should fix the docs
    // TODO: how do we get this to be in the external ram?
    let (rx_buffer, rx_descriptors, _, tx_descriptors) = dma_buffers!(3 * I2S_BYTES, 0);

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

    let mut rcv: Box<[u8]> = vec![0u8; I2S_BYTES].into_boxed_slice();

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

    // TODO: watchdog?
    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());

    // TODO: how do we configure the logger? i want timestamps

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

    // blink the onboard neopixel
    // TODO: blink all the neopixels together

    // TODO: 80MHz is cargo culted. need to find the docs for this
    // Async depends on <https://github.com/esp-rs/esp-hal-community/pull/6>
    let rmt = Rmt::new(peripherals.RMT, Rate::from_mhz(80)).expect("initializing rmt");
    // .into_async();

    let blink_fibonacci_f = blink_fibonacci256_neopixel_rmt(
        rmt.channel0,
        neopixel_builtin.degrade(),
        rmt.channel1,
        neopixel_ext2.degrade(),
    );

    // read from the i2s mic
    // TODO: how should we send the data to another task to be processed?
    let i2s_mic_f = i2s_mic_task(
        i2s_mic,
        i2s_mic_dma,
        i2s_mic_bclk.degrade(),
        i2s_mic_ws.degrade(),
        i2s_mic_data.degrade(),
    );

    // Start the tasks on core 0
    spawner
        .spawn(blink_fibonacci_f)
        .expect("spawned blink_fibonacci");
    spawner.spawn(i2s_mic_f).expect("spawned i2s mic");

    // TODO: what should we spawn on core 1?

    // TODO: what should the main loop do?
    let mut red_led = Output::new(red_led, Level::Low, OutputConfig::default());
    let mut red_led_ticker = Ticker::every(Duration::from_millis(1_000));

    loop {
        info!("Hello world!");
        red_led.toggle();
        red_led_ticker.next().await;
    }

    // for inspiration have a look at the examples at https://github.com/esp-rs/esp-hal/tree/esp-hal-v1.0.0-beta.0/examples/src/bin
}
