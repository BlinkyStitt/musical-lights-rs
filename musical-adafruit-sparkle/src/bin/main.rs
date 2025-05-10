#![no_std]
#![no_main]

use esp_hal::dma::I2s0DmaChannel;
use esp_hal::gpio::{Level, Output, OutputConfig, Pin};
use esp_hal::i2s::master::{DataFormat, I2s, Standard};
use esp_hal::peripherals::I2S0;
use esp_hal::time::Rate;
use esp_hal::timer::timg::TimerGroup;
use esp_hal::{clock::CpuClock, gpio::AnyPin};
use esp_hal::{dma_buffers, dma_circular_buffers};

use defmt::{info, warn};
use esp_println as _;

use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};

use esp_backtrace as _;

extern crate alloc;

#[embassy_executor::task]
async fn blink(pin: AnyPin) {
    let config = OutputConfig::default();

    let mut led = Output::new(pin, Level::Low, config);

    loop {
        // Timekeeping is globally available, no need to mess with hardware timers.
        led.toggle();
        Timer::after_millis(200).await;
    }
}

/// TODO: should this function take the transfer object instead? need 'static lifetimes for that to work with embassy though
#[embassy_executor::task]
async fn i2s_mic_task(i2s: I2S0, dma: I2s0DmaChannel, bclk: AnyPin, ws: AnyPin, din: AnyPin) {
    // TODO: what size should these be?
    let (rx_buffer, rx_descriptors, _, tx_descriptors) = dma_buffers!(0, 4 * 4096);

    let i2s = I2s::new(
        i2s,
        Standard::Philips,
        DataFormat::Data16Channel16,
        Rate::from_hz(44100),
        dma,
        rx_descriptors,
        tx_descriptors,
    )
    .into_async();

    let i2s_rx = i2s.i2s_rx.with_bclk(bclk).with_ws(ws).with_din(din).build();

    warn!("i2s_rx is broken. something wrong with the dma setup");
    return;

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

    esp_alloc::heap_allocator!(size: 72 * 1024);

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

    // Connect to the RX pin found on a breakout or device.
    let uart_tx = peripherals.GPIO9;

    // Connect to the TX pin found on a breakout or device
    let uart_rx = peripherals.GPIO10;

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

    let timer0 = TimerGroup::new(peripherals.TIMG1);
    esp_hal_embassy::init(timer0.timer0);

    info!("Embassy initialized!");

    // blink
    let blink_f = blink(red_led.degrade());

    // i2s mic
    let i2s_mic_f = i2s_mic_task(
        i2s_mic,
        i2s_mic_dma,
        i2s_mic_bclk.degrade(),
        i2s_mic_ws.degrade(),
        i2s_mic_data.degrade(),
    );

    // wifi
    // Note you cannot read analog inputs on ADC2 once WiFi has started, as it is shared with the WiFi hardware
    let timer1 = TimerGroup::new(peripherals.TIMG0);
    let _init = esp_wifi::init(
        timer1.timer0,
        esp_hal::rng::Rng::new(peripherals.RNG),
        peripherals.RADIO_CLK,
    )
    .unwrap();

    // Spawn some tasks
    // TODO: what should core 1 do?
    spawner.spawn(blink_f).unwrap();
    spawner.spawn(i2s_mic_f).unwrap();

    // TODO: what should the main loop do?
    loop {
        info!("Hello world!");
        Timer::after(Duration::from_secs(10)).await;
    }

    // for inspiration have a look at the examples at https://github.com/esp-rs/esp-hal/tree/esp-hal-v1.0.0-beta.0/examples/src/bin
}
