//! microphone test
#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]

use embassy_executor::Spawner;
use embassy_stm32::{
    adc::{Adc, SampleTime, VREF_CALIB_MV},
    gpio::{AnyPin, Level, Output, Speed},
    peripherals::{ADC1, PA0},
};
use embassy_time::{Delay, Timer};
use musical_lights_core::logging::info;
use {defmt_rtt as _, panic_probe as _};

#[embassy_executor::task]
pub async fn blink_task(mut led: Output<'static, AnyPin>) {
    loop {
        info!("high");
        led.set_high();
        Timer::after_millis(1000).await;

        info!("low");
        led.set_low();
        Timer::after_millis(1000).await;
    }
}

#[embassy_executor::task]
async fn mic_task(mic_adc: ADC1, mut mic_pin: PA0) {
    // TODO: i kind of wish i'd ordered the i2s mic
    let mut adc = Adc::new(mic_adc, &mut Delay);

    // TODO: what resolution?
    let adc_resolution = 12;

    let full_range = ((1 << adc_resolution) - 1) as f32;

    // let half_range = full_range / 2 + 1;

    // 100 mHz processor
    // TODO: how long should we sample?
    adc.set_sample_time(SampleTime::Cycles144);
    adc.set_resolution(embassy_stm32::adc::Resolution::TwelveBit);

    // // TODO: i think we should be able to use this instead of adc_resolution.
    // let mut vrefint = adc.enable_vrefint();
    // TODO: on other controllers, this was `vrefint.value()`
    // const VREFINT_VALUE: u32 = 1230;

    // the dc offset is printed on the microphone board
    const MIC_DC_OFFSET_MV: u32 = 1250;

    // TODO: how do we get the calibrated value out of this? I think it is 1230, but I'm not sure

    // // TODO: do we care about the temperature?
    // // TODO: shut down if hot?
    // let mut temperature = adc.enable_temperature();
    // let temp_sample = adc.read(&mut temperature);
    // info!("temp: {}", temp_sample);

    const MIC_DC_OFFSET_V: f32 = MIC_DC_OFFSET_MV as f32 / 1000.0;
    const VREF_CALIB_V: f32 = VREF_CALIB_MV as f32 / 1000.0;

    loop {
        // let vref = adc.read(&mut vrefint);
        let sample = adc.read(&mut mic_pin);

        // info!("vref raw: {}; mic raw: {}", vref, sample);

        // TODO: figure out what below is right and what is wrong
        // TODO: scale 0-4095 to millivolts. use vref to get rid of any bias. subcract dc offset. convert to float for the fft. fft wants 0 centered data

        let sample_mv = sample as f32 / full_range * VREF_CALIB_V - MIC_DC_OFFSET_V;

        // let sample_mv = (sample as u32 * VREFINT_VALUE / vref as u32) * VREF_CALIB_MV / full_range;
        info!("mic: {}", sample_mv);

        // let sample_mv = sample_mv.saturating_sub(MIC_DC_OFFSET);
        // trace!("mic mv: {}", sample_mv);

        // let sample_scaled = sample_mv as f32 / MIC_VPP;

        // TODO: i think vref should be included here, but
        // let sample = sample as f32 / range * 3.3;
        // info!("{}", sample_scaled);

        // // 44.1kHz = 22,676 nanoseconds
        Timer::after_nanos(22_676).await;
        // Timer::after_millis(10).await;
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let peripheral_config = Default::default();

    let p = embassy_stm32::init(peripheral_config);

    info!("Hello World!");

    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low).degrade();
    let mic_adc = p.ADC1;
    let mic_pin = p.PA0;

    // start an async task in the background so that we can test the async part of the leds actually works properly
    spawner.must_spawn(blink_task(onboard_led));

    // listen to the microphone
    spawner.must_spawn(mic_task(mic_adc, mic_pin));

    info!("all tasks started");
}
