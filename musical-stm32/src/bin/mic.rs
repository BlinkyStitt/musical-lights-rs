//! microphone test
#![no_std]
#![no_main]

use embassy_executor::Spawner;
use embassy_stm32::{
    Peri,
    adc::{Adc, AdcChannel, SampleTime, VREF_CALIB_MV, resolution_to_max_count},
    gpio::{Level, Output, Speed},
    peripherals::{ADC1, DMA2_CH0, PA0},
};
use embassy_time::Timer;
use musical_lights_core::logging::{info, warn};
use {defmt_rtt as _, panic_probe as _};

// TODO: what buffer length? we want 2x the number of measurements that we get when we call read
// TODO: then we want 2x again because we read the temperature as well
const MIC_SAMPLES: usize = 512;
const DMA_BUF_LEN: usize = MIC_SAMPLES * 2 * 2;

// the dc offset is printed on the microphone board. TODO: take this as an argument?
// TODO: how do we get the calibrated value out of this? I think it is 1230, but I'm not sure
const MIC_DC_OFFSET_MV: u32 = 1250;

const MIC_DC_OFFSET_V: f32 = MIC_DC_OFFSET_MV as f32 / 1000.0;
const VREF_CALIB_V: f32 = VREF_CALIB_MV as f32 / 1000.0;

#[embassy_executor::task]
pub async fn blink_task(mut led: Output<'static>) {
    loop {
        info!("high");
        led.set_high();
        Timer::after_millis(200).await;

        info!("low");
        led.set_low();
        Timer::after_millis(800).await;
    }
}

#[embassy_executor::task]
async fn mic_task(
    mic_adc: Peri<'static, ADC1>,
    mic_pin: Peri<'static, PA0>,
    dma: Peri<'static, DMA2_CH0>,
) {
    // TODO: i kind of wish i'd ordered the i2s mic
    let adc_resolution = embassy_stm32::adc::Resolution::BITS12;
    let mut adc = Adc::new_with_config(
        mic_adc,
        embassy_stm32::adc::AdcConfig {
            resolution: Some(adc_resolution),
        },
    );

    let full_range = resolution_to_max_count(adc_resolution) as f32;

    // // TODO: do we care about the temperature?
    // // TODO: shut down if hot?
    let mut temperature = adc.enable_temperature();
    let temp_sample = adc.blocking_read(&mut temperature, SampleTime::CYCLES144);
    info!("temp: {}", temp_sample);

    // let half_range = full_range / 2 + 1;

    let mut adc_dma_buf = [0u16; DMA_BUF_LEN];
    let mut ring_buffered_adc = adc.into_ring_buffered(
        dma,
        &mut adc_dma_buf,
        Irqs,
        [
            (mic_pin.degrade_adc(), SampleTime::CYCLES144),
            (temperature.degrade_adc(), SampleTime::CYCLES144),
        ]
        .into_iter(),
        embassy_stm32::adc::CONTINUOUS,
        embassy_stm32::adc::Exten::RISING_EDGE,
    );

    // 100 mHz processor. but what is the adc clock?
    // TODO: how long should we sample? one example had CYCLES144, another had CYCLES112

    // // TODO: i think we should be able to use this instead of adc_resolution.
    // let mut vrefint = adc.enable_vrefint();
    // TODO: on other controllers, this was `vrefint.value()`
    // const VREFINT_VALUE: u32 = 1230;

    let mut measurements = [0u16; DMA_BUF_LEN / 2];
    let mut modified = [0f32; DMA_BUF_LEN / 2]; // TODO: seperate arrays for mic and temperature? keep an EMA for the temp?
    loop {
        match ring_buffered_adc.read(&mut measurements).await {
            Ok(_) => {
                info!("adc1 raw: {}", measurements);

                for (i, measurement) in measurements.iter().enumerate() {
                    if i % 2 == 0 {
                        // TODO: figure out what below is right and what is wrong
                        // TODO: scale 0-4095 to millivolts. use vref to get rid of any bias. subcract dc offset. convert to float for the fft. fft wants 0 centered data

                        // max voltage should be ~2.  to make fft happy, subtract 1 to 0 center.
                        // TODO: this would probably be better with less floats, but maybe its fine
                        // TODO: use VREF_DEFAULT_MV?
                        let sample_mv = *measurement as f32 / full_range * VREF_CALIB_V
                            - MIC_DC_OFFSET_V
                            - 1000.0;

                        // let sample_mv = (sample as u32 * VREFINT_VALUE / vref as u32) * VREF_CALIB_MV / full_range;
                        // info!("mic: {}", sample_mv);

                        // let sample_mv = sample_mv.saturating_sub(MIC_DC_OFFSET);
                        // trace!("mic mv: {}", sample_mv);

                        // let sample_scaled = sample_mv as f32 / MIC_VPP;

                        // TODO: i think vref should be included here, but
                        // let sample = sample as f32 / range * 3.3;
                        // info!("{}", sample_scaled);

                        modified[i] = sample_mv;
                    } else {
                        // TODO: Modify temperature in place
                        // *measurement = convert_to_c(*measurement);
                        modified[i] = *measurement as f32;
                    }
                }

                info!("adc1 mv/c: {}", modified);

                // Only needed to manually control sample rate.
                // TODO: do we want to manually control the sample rate? i think its better to set the clocks
                // ring_buffered_adc.teardown_adc();

                // TODO: should the sleep be here?
            }
            Err(e) => {
                warn!("Error: {:?}", e);
                // DMA overrun, next call to `read` restarts ADC.
            }
        }

        // let vref = adc.blocking_read(&mut vrefint);
        // let sample = adc.blocking_read(&mut mic_pin);
        // info!("vref raw: {}; mic raw: {}", vref, sample);
        // 44.1kHz = 22,676 nanoseconds
        // Timer::after_nanos(22_676 * measurements.len()).await;
        // Timer::after_millis(10).await;
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let peripheral_config = Default::default();

    // TODO: change the clocks on the ADC?

    let p = embassy_stm32::init(peripheral_config);

    info!("Hello World!");

    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low);
    let mic_adc = p.ADC1;
    let mic_pin = p.PA0;
    let mic_dma = p.DMA2_CH0;

    // start an async task in the background so that we can test the async part of the leds actually works properly
    spawner.spawn(blink_task(onboard_led).expect("task allocation failed"));

    // listen to the microphone
    spawner.spawn(mic_task(mic_adc, mic_pin, mic_dma).expect("task allocation failed"));

    info!("all tasks started");
}

embassy_stm32::bind_interrupts!(struct Irqs {
    DMA2_STREAM0 => embassy_stm32::dma::InterruptHandler<embassy_stm32::peripherals::DMA2_CH0>;
});
