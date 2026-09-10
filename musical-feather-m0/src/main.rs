#![no_std]
#![no_main]

#[cfg(not(feature = "use_semihosting"))]
use panic_halt as _;
#[cfg(feature = "use_semihosting")]
use panic_semihosting as _;

/// TODO: feature for which hal to use? i think writing memory.x and similar files are more challenging then
use feather_m0 as bsp;

use bsp::hal::clock::GenericClockController;
use bsp::pac::{CorePeripherals, Peripherals};
use bsp::pin_alias;
use embassy_executor::Spawner;
use log::{debug, info};
// use embassy_time::Timer;

/// TODO: make sure SAMPLE_BUFFER >= MIC_SAMPLES
/// TODO: support SAMPLE_BUFFER > MIC_SAMPLES

#[embassy_executor::main]
async fn main(_spawner: Spawner) {
    // TODO: configure log (or better, use defmt)

    info!("hello, world!");

    let mut peripherals = Peripherals::take().unwrap();
    let _core = CorePeripherals::take().unwrap();
    let _clocks = GenericClockController::with_external_32kosc(
        peripherals.gclk,
        &mut peripherals.pm,
        &mut peripherals.sysctrl,
        &mut peripherals.nvmctrl,
    );
    let pins = bsp::Pins::new(peripherals.port);
    let _red_led: bsp::RedLed = pin_alias!(pins.red_led).into();
    // let mut delay = Delay::new(core.SYST, &mut clocks);

    // TODO: what pin?
    // let mic_pin = pins.A1;

    // TODO: channel to send samples from microphone to buffer

    // spawner.spawn(read_mic_task(mic_pin).expect("task allocation failed"));
    // spawner.spawn(blink_task(red_led).expect("task allocation failed"));

    debug!("all tasks spawned");
}
