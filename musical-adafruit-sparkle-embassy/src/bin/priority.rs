//! TODO: i think the executor tasks should take the specific pins/peripherials. then it should call a generic function that takes AnyPin

#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]
#![no_std]
#![no_main]

use defmt::info;
use embassy_executor::Spawner;
use embassy_time::{Duration, Instant, Ticker, Timer};
use esp_backtrace as _;
use esp_hal::interrupt::software::SoftwareInterruptControl;
use esp_hal::interrupt::Priority;
use esp_hal::timer::timg::TimerGroup;
use esp_hal::timer::AnyTimer;
use esp_hal_embassy::InterruptExecutor;
use esp_println as _;
use static_cell::StaticCell;

extern crate alloc;

/// Periodically print something.
#[embassy_executor::task]
async fn high_prio() {
    info!("Starting high_prio()");
    let mut ticker = Ticker::every(Duration::from_secs(1));
    loop {
        info!("High priority ticks");
        ticker.next().await;
    }
}

/// Simulates some blocking (badly behaving) task.
#[embassy_executor::task]
async fn low_prio_blocking() {
    info!("Starting low-priority task that isn't actually async");
    loop {
        info!("Doing some long and complicated calculation");
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {}
        info!("Calculation finished");
        Timer::after(Duration::from_secs(5)).await;
    }
}

/// A well-behaved, but starved async task.
#[embassy_executor::task]
async fn low_prio_async() {
    info!(
        "Starting low-priority task that will not be able to run while the blocking task is running"
    );
    let mut ticker = Ticker::every(Duration::from_secs(1));
    loop {
        info!("Low priority ticks");
        ticker.next().await;
    }
}

#[esp_hal_embassy::main]
async fn main(low_prio_spawner: Spawner) {
    info!("Init!");

    esp_alloc::heap_allocator!(size: 72 * 1024);

    let peripherals = esp_hal::init(esp_hal::Config::default());

    let sw_ints = SoftwareInterruptControl::new(peripherals.SW_INTERRUPT);

    let timg0 = TimerGroup::new(peripherals.TIMG0);
    let timer0: AnyTimer = timg0.timer0.into();

    let timg1 = TimerGroup::new(peripherals.TIMG1);
    let timer1: AnyTimer = timg1.timer0.into();

    esp_hal_embassy::init([timer0, timer1]);

    static EXECUTOR: StaticCell<InterruptExecutor<2>> = StaticCell::new();
    let executor = InterruptExecutor::new(sw_ints.software_interrupt2);
    let executor = EXECUTOR.init(executor);

    let spawner = executor.start(Priority::Priority3);
    spawner.must_spawn(high_prio());

    info!("Spawning low-priority tasks");
    low_prio_spawner.must_spawn(low_prio_async());
    low_prio_spawner.must_spawn(low_prio_blocking());
}
