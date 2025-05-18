//! sensor board for the adafruit sparkle
//! this stm32 connects to all the sensors and sends the data across a serial connection to the adafruit sparkle
#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

use embassy_executor::Spawner;
use embassy_stm32::{gpio::{Level, Output, Speed}, usart::BufferedUart};
use embassy_sync::channel::Channel;
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

    info!("Hello World!");

    // set up pins
    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low);

    BufferedUart::new(p.USART1, p.)

    // setup pins for Radio, GPS, Accelerometer, and maybe some other sensors

    // TODO: set up UART for communication with the adafruit sparkle

    // spawn the tasks
    spawner.must_spawn(blink_task(onboard_led));

    // TODO: spawn the tasks for the sensors
    // TODO: spawn the task for the uart

    info!("all tasks started");
}
