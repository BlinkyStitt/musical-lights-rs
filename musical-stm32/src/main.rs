#![no_std]
#![no_main]

use embassy_executor::Spawner;
use embassy_stm32::adc::{self, Adc, SampleTime};
use embassy_stm32::bind_interrupts;
use embassy_stm32::gpio::{Level, Output, Speed};
use embassy_stm32::peripherals::{ADC1, IWDG, PA0, PA5};
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

bind_interrupts!(struct Irqs {
    ADC1_2 => adc::InterruptHandler<ADC1>;
});

const FFT_INPUTS: usize = 2048;
const FFT_OUTPUTS: usize = 1024;

#[embassy_executor::task]
async fn blink_task(mut led: Output<'static, PA5>) {
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
    tx: Sender<'static, ThreadModeRawMutex, u16, 16>,
) {
    // TODO: i kind of wish i'd ordered the i2s mic
    let mut adc = Adc::new(mic_adc, Irqs, &mut Delay);

    // 100 mHz processor
    // TODO: how long should we sample? how do we set the resolution to 12 bit?
    adc.set_sample_time(SampleTime::Cycles61_5);

    // let vrefint = adc.enable_vref(&mut Delay);
    // let vrefint_sample = vrefint.value();

    // // TODO: do we care about the temperature?
    // // TODO: shut down if hot?
    // let mut temperature = adc.enable_temperature();
    // let temp_sample = adc.read(&mut temperature).await;
    // info!("temp: {}", temp_sample);

    loop {
        let sample = adc.read(&mut mic_pin).await;

        tx.send(sample).await;

        // 44.1kHz = 22,676 nanoseconds
        Timer::after_nanos(22_676).await;
    }
}

#[embassy_executor::task]
async fn fft_task(
    mic_rx: Receiver<'static, ThreadModeRawMutex, u16, 16>,
    loudness_tx: Sender<'static, ThreadModeRawMutex, BarkScaleAmplitudes, 16>,
) {
    // TODO: how do we set resolution? 12 bit is slower than 6. but 12 is probably fast enough. i think 12 is the default
    let resolution = 12;
    let sample_rate = 44_100;

    let range = 2.0f32.powi(resolution) - 1.0;

    let mut audio_buffer = AudioBuffer::<512, FFT_INPUTS>::new();

    let fft: FFT<FFT_INPUTS, FFT_OUTPUTS> =
        FFT::a_weighting::<HanningWindow<FFT_INPUTS>>(sample_rate);

    // TODO: what sample rate?
    let bark_scale_builder = BarkScaleBuilder::new(sample_rate);

    // TODO: track a peak and have it decay slowly

    loop {
        let sample = mic_rx.receive().await;

        // let millivolts = convert_to_millivolts(sample, vrefint_sample);
        // info!("mic: {} mV", millivolts);

        let sample = sample as f32 / range;

        trace!("mic: {}", sample);

        if audio_buffer.buffer_sample(sample) {
            // every `S` samples (probably 512), do an FFT
            let samples = audio_buffer.copy_buffered_samples();

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
    let led = Output::new(p.PA5, Level::High, Speed::Low);

    let mic_adc = p.ADC1;
    let mic_pin = p.PA0;

    // TODO: pin_alias?

    // channel for mic samples -> FFT
    static MIC_CHANNEL: Channel<ThreadModeRawMutex, u16, 16> = Channel::new();
    let mic_tx = MIC_CHANNEL.sender();
    let mic_rx = MIC_CHANNEL.receiver();

    // channel for FFT -> LEDs
    static LOUDNESS_CHANNEL: Channel<ThreadModeRawMutex, BarkScaleAmplitudes, 16> = Channel::new();
    let loudness_tx = LOUDNESS_CHANNEL.sender();
    let loudness_rx = LOUDNESS_CHANNEL.receiver();

    // spawn the tasks
    spawner.must_spawn(blink_task(led));
    spawner.must_spawn(mic_task(mic_adc, mic_pin, mic_tx));
    spawner.must_spawn(fft_task(mic_rx, loudness_tx));
    spawner.must_spawn(light_task(loudness_rx));
}
