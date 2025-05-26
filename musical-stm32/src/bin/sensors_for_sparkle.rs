//! sensor board for the adafruit sparkle
//! this stm32 connects to all the sensors and sends the data across a serial connection to the adafruit sparkle
#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

use embassy_executor::Spawner;
use embassy_stm32::{
    bind_interrupts,
    gpio::{Level, Output, Speed},
    peripherals,
    usart::{self, BufferedUart, Config},
};
use embassy_time::Timer;
use musical_lights_core::logging::info;
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
    let mut tx1_buf = [0u8; 32];
    let mut rx1_buf = [0u8; 32];

    let tx1_config = Config::default();

    info!("Hello World!");

    // set up devices
    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low);

    // TODO: why don't we need to specify any dma channels here?
    // TODO: buffered or ring buffered?
    let uart_1 = BufferedUart::new(
        p.USART1,
        Irqs,
        rx1_pin,
        tx1_pin,
        &mut tx1_buf,
        &mut rx1_buf,
        tx1_config,
    )
    .expect("failed to create UART1");

    let (uart1_tx, uart1_rx) = uart_1.split();

    // TODO: wait here for the other side's uart to be ready?

    // spawn the tasks
    spawner.must_spawn(blink_task(onboard_led));

    // TODO: spawn the tasks for the sensors
    // TODO: spawn the task for the uart

    info!("all tasks started");
}
