#![no_std]
#![no_main]

use esp_hal::gpio::{Level, Output, OutputConfig, Pin};
use esp_hal::timer::timg::TimerGroup;
use esp_hal::{clock::CpuClock, gpio::AnyPin};

use defmt::info;
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
        led.set_high();
        Timer::after_millis(150).await;
        led.set_low();
        Timer::after_millis(150).await;
    }
}

#[esp_hal_embassy::main]
async fn main(spawner: Spawner) {
    // generator version: 0.3.1

    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());
    let peripherals = esp_hal::init(config);

    esp_alloc::heap_allocator!(size: 72 * 1024);

    let timer0 = TimerGroup::new(peripherals.TIMG1);
    esp_hal_embassy::init(timer0.timer0);

    info!("Embassy initialized!");

    let timer1 = TimerGroup::new(peripherals.TIMG0);
    let _init = esp_wifi::init(
        timer1.timer0,
        esp_hal::rng::Rng::new(peripherals.RNG),
        peripherals.RADIO_CLK,
    )
    .unwrap();

    // Spawn some tasks
    spawner.spawn(blink(peripherals.GPIO4.degrade())).unwrap();

    // TODO: what should the main loop do?

    // TODO: what should core 1 do?

    loop {
        info!("Hello world!");
        Timer::after(Duration::from_secs(1)).await;
    }

    // for inspiration have a look at the examples at https://github.com/esp-rs/esp-hal/tree/esp-hal-v1.0.0-beta.0/examples/src/bin
}
