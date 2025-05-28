//! sensor board for the adafruit sparkle
//! this stm32 connects to all the sensors and sends the data across a serial connection to the adafruit sparkle
#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

use embassy_embedded_hal::shared_bus::asynch::spi::SpiDevice;
use embassy_executor::Spawner;
use embassy_stm32::{
    bind_interrupts,
    gpio::{Level, Output, Speed},
    pac::Interrupt::SPI2,
    peripherals,
    spi::{self, Spi},
    time::Hertz,
    usart::{self, BufferedUart, Config},
};
use embassy_sync::{
    blocking_mutex::{CriticalSectionMutex, raw::CriticalSectionRawMutex},
    mutex::Mutex,
};
use embassy_time::Timer;
use musical_lights_core::logging::info;
use musical_lights_core::message::MESSAGE_BAUD_RATE;
use {defmt_rtt as _, panic_probe as _};

#[embassy_executor::task]
async fn blink_task(mut led: Output<'static>) {
    loop {
        info!("high");
        led.set_high();
        Timer::after_millis(1000).await;

        info!("low");
        led.set_low();
        Timer::after_millis(1000).await;
    }
}

// TODO: what tasks do we need?
// - read gps data
// - read accelerometer data
// - read magnetometer data
// - read radio data
// - send radio data

bind_interrupts!(struct Irqs {
    USART1 => usart::BufferedInterruptHandler<peripherals::USART1>;
    USART2 => usart::BufferedInterruptHandler<peripherals::USART2>;
});

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    // // TODO: i think we might want non-default clocks: https://github.com/embassy-rs/embassy/blob/main/examples/stm32f334/src/bin/adc.rs
    // let mut config = Config::default();
    // config.rcc.sysclk = Some(mhz(64));
    // config.rcc.hclk = Some(mhz(64));
    // config.rcc.pclk1 = Some(mhz(32));
    // config.rcc.pclk2 = Some(mhz(64));
    // config.rcc.adc = Some(AdcClockSource::Pll(Adcpres::DIV1));
    let peripheral_config = Default::default();

    let p = embassy_stm32::init(peripheral_config);

    // TODO: these pins are probably wrong. check the pin diagram
    let tx1_pin = p.PB6; // USART1 TX pin
    let rx1_pin = p.PB7; // USART1 RX pin

    // TODO: what size do these need to be?
    let mut tx_sparkle_buf = [0u8; 256];
    let mut rx_sparkle_buf = [0u8; 256];

    let mut tx_gps_buf = [0u8; 256];
    let mut rx_gps_buf = [0u8; 256];

    info!("Hello World!");

    // set up devices
    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low);

    let mut uart_sparkle_config = Config::default();
    uart_sparkle_config.baudrate = MESSAGE_BAUD_RATE; // this baud rate needs to match the sparkle's baud rate

    let uart_sparkle = BufferedUart::new(
        p.USART1,
        Irqs,
        rx1_pin,
        tx1_pin,
        &mut tx_sparkle_buf,
        &mut rx_sparkle_buf,
        uart_sparkle_config,
    )
    .expect("failed to create UART1 for sparkle");

    let (uart_sparkle_tx, uart_sparkle_rx) = uart_sparkle.split();

    let mut uart_gps_config = Config::default();
    uart_gps_config.baudrate = 9600; // GPS baud rate, this must match the GPS module's baud rate

    let uart_gps = BufferedUart::new(
        p.USART2,
        Irqs,
        p.PA3, // USART2 TX pin
        p.PA2, // USART2 RX pin
        &mut tx_gps_buf,
        &mut rx_gps_buf,
        uart_gps_config,
    )
    .expect("failed to create UART2 for gps");

    // TODO: do we actually want to split this? i think it will probably be easier to sent then wait on the receiver, but maybe not
    let (uart_gps_tx, uart_gps_rx) = uart_gps.split();

    let mut spi_config = spi::Config::default();
    // TODO: what frequency?
    spi_config.frequency = Hertz(1_000_000);

    // TODO: what pins? any other spi things? maybe multiple spi_bus so we can do dma for two things at once?
    let spi_cs_accel_gyro = p.PA8;
    let spi_cs_magnetometer = p.PA9;

    let spi_bus = Mutex::<CriticalSectionRawMutex, _>::new(Spi::new(
        p.SPI1, p.PA5, p.PA7, p.PA6, p.DMA2_CH2, p.DMA2_CH0, spi_config,
    ));

    // TODO: do we care about interrupts for these? having it respond quickly to changes will probably be a good idea. but that can come later. polling is fine for now
    let spi_accel_gyro = SpiDevice::new(&spi_bus, spi_cs_accel_gyro);
    let spi_magnetometer = SpiDevice::new(&spi_bus, spi_cs_magnetometer);

    // TODO: capacitive touch for controlling the brightness and other things

    // TODO: wait here for a ping from the sparkle before doing anything? or should we just start sending on a schedule?

    // spawn the tasks
    spawner.must_spawn(blink_task(onboard_led));

    // TODO: spawn the tasks for the sensors
    // TODO: spawn the task for the uart

    info!("all tasks started");
}
