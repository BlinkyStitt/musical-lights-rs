#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

#[cfg(not(feature = "use_semihosting"))]
use panic_halt as _;
#[cfg(feature = "use_semihosting")]
use panic_semihosting as _;

/// TODO: feature for which hal to use? i think writing memory.x and similar files are more challenging then
use feather_m0 as bsp;

use bsp::hal::clock::GenericClockController;
use bsp::pac::{CorePeripherals, Peripherals};
use bsp::{pin_alias};
use embassy_executor::Spawner;
use log::{debug, info};
// use embassy_time::Timer;

const MIC_SAMPLES: usize = 512;
const NUM_CHANNELS: usize = 24;

/// TODO: make sure SAMPLE_BUFFER >= MIC_SAMPLES
/// TODO: support SAMPLE_BUFFER > MIC_SAMPLES
const SAMPLE_BUFFER: usize = 2048;
const FFT_BINS: usize = SAMPLE_BUFFER / 2;

#[embassy_executor::main]
async fn main(_spawner: Spawner) {
    // TODO: configure log (or better, use defmt)

    info!("hello, world!");

    let mut peripherals = Peripherals::take().unwrap();
    let core = CorePeripherals::take().unwrap();
    let clocks = GenericClockController::with_external_32kosc(
        peripherals.GCLK,
        &mut peripherals.PM,
        &mut peripherals.SYSCTRL,
        &mut peripherals.NVMCTRL,
    );
    let pins = bsp::Pins::new(peripherals.PORT);
    let red_led: bsp::RedLed = pin_alias!(pins.red_led).into();
    // let mut delay = Delay::new(core.SYST, &mut clocks);

    // TODO: what pin?
    // let mic_pin = pins.A1;

    // TODO: channel to send samples from microphone to buffer

    // spawner.must_spawn(read_mic_task(mic_pin));
    // spawner.must_spawn(blink_task(red_led));

    debug!("all tasks spawned");
}
