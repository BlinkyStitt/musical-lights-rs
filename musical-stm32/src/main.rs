#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]

use embassy_executor::Spawner;
use embassy_stm32::adc::{Adc, SampleTime};
use embassy_stm32::gpio::{Level, Output, Speed};
use embassy_stm32::peripherals::{ADC1, IWDG, PA0, PC13};
use embassy_stm32::wdg::IndependentWatchdog;
use embassy_sync::blocking_mutex::raw::ThreadModeRawMutex;
use embassy_sync::channel::{Channel, Receiver, Sender};
use embassy_time::{Delay, Timer};
use micromath::F32Ext;
use musical_lights_core::{
    audio::{AggregatedAmplitudesBuilder, AudioBuffer, BarkScaleAmplitudes, BarkScaleBuilder, FFT},
    logging::{info, trace},
    windows::HanningWindow,
};
use {defmt_rtt as _, panic_probe as _};

const MIC_SAMPLES: usize = 512;
const FFT_INPUTS: usize = 2048;
const FFT_OUTPUTS: usize = 1024;

/// oh. this is why they packed it in the first Complex. Because it's helpful to keep connected to the samples
const SAMPLE_RATE: u32 = 44_100;

// const VREF_NOMINAL: u16 = 3300;
// const VREFINT_CALIBRATED: u16 = 1230;

#[embassy_executor::task]
async fn blink_task(mut led: Output<'static, PC13>) {
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
async fn mic_task(
    mic_adc: ADC1,
    mut mic_pin: PA0,
    tx: Sender<'static, ThreadModeRawMutex, f32, 16>,
    // vref_nominal: u16,
    // vrefint_calibrated: u16,
) {
    // TODO: i kind of wish i'd ordered the i2s mic
    let mut adc = Adc::new(mic_adc, &mut Delay);

    // TODO: what resolution?
    let adc_resolution = 12;

    let range = 2.0f32.powi(adc_resolution) - 1.0;

    let half_range = range / 2.0 + 1.0;

    // 100 mHz processor
    // TODO: how long should we sample?
    adc.set_sample_time(SampleTime::Cycles144);
    adc.set_resolution(embassy_stm32::adc::Resolution::TwelveBit);

    // // TODO: i think we should be able to use this instead of adc_resolution.
    // let mut vrefint = adc.enable_vrefint();

    // TODO: how do we get the calibrated value out of this? I think it is 1230, but I'm not sure

    // // TODO: do we care about the temperature?
    // // TODO: shut down if hot?
    // let mut temperature = adc.enable_temperature();
    // let temp_sample = adc.read(&mut temperature).await;
    // info!("temp: {}", temp_sample);

    loop {
        // let vref = adc.read(&mut vrefint);

        let sample = adc.read(&mut mic_pin);

        trace!("mic u16: {}", sample);

        // scale 0-4095 to millivolts
        // TODO: is this right?
        // let sample_mv = (sample * vrefint.value() as u32 / vref as u32) * 3300 / 4095;

        let sample = (sample as f32 - half_range) / half_range;

        trace!("mic f32: {}", sample);

        tx.send(sample).await;

        // 44.1kHz = 22,676 nanoseconds
        Timer::after_nanos(22_676).await;
    }
}

#[embassy_executor::task]
async fn fft_task(
    mut audio_buffer: AudioBuffer<MIC_SAMPLES, FFT_INPUTS>,
    fft: FFT<FFT_INPUTS, FFT_OUTPUTS>,
    bark_scale_builder: BarkScaleBuilder<FFT_OUTPUTS>,
    mic_rx: Receiver<'static, ThreadModeRawMutex, f32, 16>,
    loudness_tx: Sender<'static, ThreadModeRawMutex, BarkScaleAmplitudes, 16>,
) {
    loop {
        let sample = mic_rx.receive().await;

        // let millivolts = convert_to_millivolts(sample, vrefint_sample);
        // info!("mic: {} mV", millivolts);

        if audio_buffer.push_sample(sample) {
            // every `MIC_SAMPLES` samples (probably 512), do an FFT
            let samples = audio_buffer.samples();

            let amplitudes = fft.weighted_amplitudes(samples);

            let loudness = bark_scale_builder.build(amplitudes);

            // TODO: scaled loudness where a slowly decaying recent min = 0.0 and recent max = 1.0

            // TODO: shazam
            // TODO: beat detection

            loudness_tx.send(loudness).await;
        }
    }
}

// TODO: i think we don't actually want decibels. we want relative values to the most recently heard loud sound
#[embassy_executor::task]
async fn light_task(loudness_rx: Receiver<'static, ThreadModeRawMutex, BarkScaleAmplitudes, 16>) {
    loop {
        let loudness = loudness_rx.receive().await;

        info!("{:?}", loudness);
    }
}

#[embassy_executor::task]
async fn watchdog_task(mut wdg: IndependentWatchdog<'static, IWDG>) {
    info!("Watchdog start");
    wdg.unleash();

    loop {
        info!("Watchdog pet");
        Timer::after_secs(1).await;

        wdg.pet();
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
    let config = Default::default();

    let p = embassy_stm32::init(config);

    info!("Hello World!");

    // start the watchdog
    let wdg = IndependentWatchdog::new(p.IWDG, 2_000_000);

    spawner.must_spawn(watchdog_task(wdg));

    // set up pins
    let led = Output::new(p.PC13, Level::High, Speed::Low);

    let mic_adc = p.ADC1;
    let mic_pin = p.PA0;

    // TODO: pin_alias?

    // channel for mic samples -> FFT
    static MIC_CHANNEL: Channel<ThreadModeRawMutex, f32, 16> = Channel::new();
    let mic_tx = MIC_CHANNEL.sender();
    let mic_rx = MIC_CHANNEL.receiver();

    // channel for FFT -> LEDs
    static LOUDNESS_CHANNEL: Channel<ThreadModeRawMutex, BarkScaleAmplitudes, 16> = Channel::new();
    let loudness_tx = LOUDNESS_CHANNEL.sender();
    let loudness_rx = LOUDNESS_CHANNEL.receiver();

    // create windows and weights and everything before starting any tasks
    let audio_buffer = AudioBuffer::<MIC_SAMPLES, FFT_INPUTS>::new();

    let fft: FFT<FFT_INPUTS, FFT_OUTPUTS> =
        FFT::a_weighting::<HanningWindow<FFT_INPUTS>>(SAMPLE_RATE);

    let bark_scale_builder = BarkScaleBuilder::new(SAMPLE_RATE);

    setup_leds().await;

    // all the hardware should be set up now.

    // spawn the tasks
    spawner.must_spawn(blink_task(led));

    spawner.must_spawn(mic_task(mic_adc, mic_pin, mic_tx));
    spawner.must_spawn(fft_task(
        audio_buffer,
        fft,
        bark_scale_builder,
        mic_rx,
        loudness_tx,
    ));

    spawner.must_spawn(light_task(loudness_rx));
}

async fn setup_leds() {
    // TODO: clear the led matrix

    // TODO: 1 red, 2 green, 3 blue, 4 white

    // TODO: sleep

    // TODO: clear the leds
}
