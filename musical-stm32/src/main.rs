#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]

use core::iter::repeat;

use embassy_executor::Spawner;
use embassy_futures::join::join;
use embassy_stm32::adc::{Adc, SampleTime};
use embassy_stm32::gpio::{AnyPin, Level, Output, Speed};
use embassy_stm32::peripherals::{
    ADC1, DMA1_CH3, DMA1_CH4, DMA2_CH0, DMA2_CH2, IWDG, PA0, PB15, PB5, SPI1, SPI2,
};
use embassy_stm32::spi::{Config as SpiConfig, Spi};
use embassy_stm32::time::mhz;
use embassy_stm32::wdg::IndependentWatchdog;
use embassy_sync::blocking_mutex::raw::ThreadModeRawMutex;
use embassy_sync::channel::{Channel, Receiver, Sender};
use embassy_time::{Delay, Timer};
use micromath::F32Ext;
use musical_lights_core::lights::{
    color_correction, color_order::GRB, convert_color, DancingLights,
};
use musical_lights_core::{
    audio::{
        AggregatedAmplitudesBuilder, AudioBuffer, ExponentialScaleAmplitudes,
        ExponentialScaleBuilder, FFT,
    },
    logging::{debug, info, trace},
    windows::HanningWindow,
};
use palette::{white_point, Hsluv, ShiftHueAssign};
use smart_leds::RGB8;
use {defmt_rtt as _, panic_probe as _};

const MIC_SAMPLES: usize = 512;
const FFT_INPUTS: usize = 2048;
const FFT_OUTPUTS: usize = 1024;
const MATRIX_X: usize = 32;
const MATRIX_Y: u8 = 8;

type MatrixWhitePoint = white_point::E;

/// oh. this is why they packed it in the first Complex. Because it's helpful to keep connected to the samples
const SAMPLE_RATE: f32 = 44_100.0;

const MATRIX_N: usize = MATRIX_X * MATRIX_Y as usize;

const MATRIX_BUFFER: usize = MATRIX_N * 12;

// const VREF_NOMINAL: u16 = 3300;
// const VREFINT_CALIBRATED: u16 = 1230;

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
    // TODO: impl From<u8> for Resolution? or maybe have "bits" and "range" functions on Resolution
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

        // 0-centered
        let sample = (sample as f32 - half_range) / half_range;

        trace!("mic f32: {}", sample);

        tx.send(sample).await;

        // TODO: how accurate is this timer? we would probably do better with a smarter cheap and reading samples over i2s or spi
        // 44.1kHz = 22,676 nanoseconds
        Timer::after_nanos(22_676).await;
    }
}

#[embassy_executor::task]
async fn fft_task(
    mic_rx: Receiver<'static, ThreadModeRawMutex, f32, 16>,
    loudness_tx: Sender<'static, ThreadModeRawMutex, ExponentialScaleAmplitudes<MATRIX_X>, 16>,
) {
    // create windows and weights and everything before starting any tasks
    let mut audio_buffer: AudioBuffer<MIC_SAMPLES, FFT_INPUTS> = AudioBuffer::new();

    let fft: FFT<FFT_INPUTS, FFT_OUTPUTS> =
        FFT::a_weighting::<HanningWindow<FFT_INPUTS>>(SAMPLE_RATE);

    let scale_builder =
        ExponentialScaleBuilder::<FFT_OUTPUTS, MATRIX_X>::new(20.0, 19_000.0, SAMPLE_RATE);

    loop {
        let sample = mic_rx.receive().await;

        // let millivolts = convert_to_millivolts(sample, vrefint_sample);
        // info!("mic: {} mV", millivolts);

        if audio_buffer.push_sample(sample) {
            // every `MIC_SAMPLES` samples (probably 512), do an FFT
            let samples = audio_buffer.samples();

            let amplitudes = fft.weighted_amplitudes(samples);

            let loudness = scale_builder.build(amplitudes);

            // TODO: scaled loudness where a slowly decaying recent min = 0.0 and recent max = 1.0

            // TODO: shazam
            // TODO: beat detection

            loudness_tx.send(loudness).await;
        }
    }
}

pub type LedWriter<'a> = ws2812_async::Ws2812<Spi<'a, SPI1, DMA2_CH2, DMA2_CH0>, { MATRIX_N * 12 }>;

pub fn color_corrected_matrix<I>(iter: I) -> impl Iterator<Item = RGB8>
where
    I: Iterator<Item = RGB8>,
{
    color_correction::<GRB, I>(iter, 32, MATRIX_N)
}

// TODO: i think we don't actually want decibels. we want relative values to the most recently heard loud sound
#[allow(clippy::too_many_arguments)]
#[embassy_executor::task]
async fn light_task(
    left_mosi: PB5,
    left_peri: SPI1,
    left_rxdma: DMA2_CH0,
    left_txdma: DMA2_CH2,
    right_mosi: PB15,
    right_peri: SPI2,
    right_rxmda: DMA1_CH3,
    right_txdma: DMA1_CH4,
    loudness_rx: Receiver<'static, ThreadModeRawMutex, ExponentialScaleAmplitudes<MATRIX_X>, 16>,
) {
    let mut spi_config = SpiConfig::default();

    // TODO: this setup feels like it should be inside leds::Ws2812. like frequency check that its >2 and <3.8
    spi_config.frequency = mhz(38) / 10u32; // 3.8MHz
    spi_config.mode = embassy_stm32::spi::MODE_0;

    let spi_left = Spi::new_txonly_nosck(left_peri, left_mosi, left_txdma, left_rxdma, spi_config);
    let spi_right =
        Spi::new_txonly_nosck(right_peri, right_mosi, right_txdma, right_rxmda, spi_config);

    let mut led_left = ws2812_async::Ws2812::<_, { MATRIX_BUFFER }>::new(spi_left);
    let mut led_right = ws2812_async::Ws2812::<_, { MATRIX_BUFFER }>::new(spi_right);

    // blank the leds
    let blank_iter = || repeat(RGB8::new(0, 0, 0));

    let blank_left_f = led_left.write(color_corrected_matrix(blank_iter()));
    let blank_right_f = led_right.write(color_corrected_matrix(blank_iter()));

    let (left, right) = join(blank_left_f, blank_right_f).await;

    left.unwrap();
    right.unwrap();

    Timer::after_millis(100).await;

    // do a test pattern that makes it easy to tell if RGB is set up correctly
    const TEST_PATTERN: [RGB8; 16] = [
        RGB8::new(255, 0, 0),
        RGB8::new(0, 255, 0),
        RGB8::new(0, 255, 0),
        RGB8::new(0, 0, 255),
        RGB8::new(0, 0, 255),
        RGB8::new(0, 0, 255),
        RGB8::new(0, 0, 0),
        RGB8::new(0, 0, 0),
        RGB8::new(255, 255, 255),
        RGB8::new(255, 255, 255),
        RGB8::new(255, 255, 255),
        RGB8::new(255, 255, 255),
        RGB8::new(255, 255, 255),
        RGB8::new(255, 255, 255),
        RGB8::new(255, 255, 255),
        RGB8::new(255, 255, 255),
    ];

    let test_iter = || {
        TEST_PATTERN
            .iter()
            .copied()
            .chain(blank_iter())
            .take(MATRIX_N)
    };

    let test_left_f = led_left.write(color_corrected_matrix(test_iter()));
    let test_right_f = led_right.write(color_corrected_matrix(test_iter()));

    let (left, right) = join(test_left_f, test_right_f).await;

    left.unwrap();
    right.unwrap();

    Timer::after_secs(2).await;

    // fill one panel with red and the other with blue
    let fill_red_iter = || repeat(RGB8::new(255, 0, 0));
    let fill_blue_iter = || repeat(RGB8::new(0, 0, 255));

    let fill_left_f = led_left.write(color_corrected_matrix(fill_red_iter()));
    let fill_right_f = led_right.write(color_corrected_matrix(fill_blue_iter()));

    let (left, right) = join(fill_left_f, fill_right_f).await;

    left.unwrap();
    right.unwrap();

    Timer::after_secs(1).await;

    // TODO: setup seems to crash the program. blocking code must not be done correctly :(
    // TODO: how many ticks per decay?
    let mut dancing_lights = DancingLights::<MATRIX_X, MATRIX_Y>::new();

    // TODO: what white point?
    let mut left_color: Hsluv<MatrixWhitePoint, f32> = Hsluv::new(0.0, 100.0, 50.0);
    let mut right_color: Hsluv<MatrixWhitePoint, f32> = Hsluv::new(180.0, 100.0, 50.0);

    loop {
        // TODO: i want to draw with a framerate, but we draw every time we receive. think about this more
        let loudness = loudness_rx.receive().await;

        dancing_lights.update(loudness);

        let left_rgb = convert_color(left_color);
        let right_rgb = convert_color(right_color);

        let fill_left_f = led_left.write(color_corrected_matrix(repeat(left_rgb)));
        let fill_right_f = led_right.write(color_corrected_matrix(repeat(right_rgb)));

        let (left, right) = join(fill_left_f, fill_right_f).await;

        left.unwrap();
        right.unwrap();

        // TODO: how much should we shift? i think we want to do this differently. we want to use a gradient helper
        left_color.shift_hue_assign(0.1);
        right_color.shift_hue_assign(0.1);
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
    let peripheral_config = Default::default();

    let p = embassy_stm32::init(peripheral_config);

    info!("Hello World!");
    Timer::after_secs(1).await;

    // TODO: what pins? i copied these from <https://github.com/embassy-rs/embassy/blob/main/examples/stm32f3/src/bin/spi_dma.rs>
    let left_peri = p.SPI1;
    // let light_sck = p.PB3;
    let left_mosi = p.PB5;
    // let light_miso = p.PB4;

    let right_peri = p.SPI2;
    let right_mosi = p.PB15;

    // TODO: What channels? NoDMA for receiver?
    let left_rxdma = p.DMA2_CH0;
    let left_txdma = p.DMA2_CH2;

    let right_rxdma = p.DMA1_CH3;
    let right_txdma = p.DMA1_CH4;

    // // start the watchdog
    // let wdg = IndependentWatchdog::new(p.IWDG, 5_000_000);
    // spawner.must_spawn(watchdog_task(wdg));

    // set up pins
    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low).degrade();

    let mic_adc = p.ADC1;
    let mic_pin = p.PA0;

    // TODO: pin_alias?

    // channel for mic samples -> FFT
    static MIC_CHANNEL: Channel<ThreadModeRawMutex, f32, 16> = Channel::new();
    let mic_tx = MIC_CHANNEL.sender();
    let mic_rx = MIC_CHANNEL.receiver();

    // channel for FFT -> LEDs
    static LOUDNESS_CHANNEL: Channel<ThreadModeRawMutex, ExponentialScaleAmplitudes<MATRIX_X>, 16> =
        Channel::new();
    let loudness_tx = LOUDNESS_CHANNEL.sender();
    let loudness_rx = LOUDNESS_CHANNEL.receiver();

    // all the hardware should be set up now.
    debug!("spawning tasks 1");

    // spawn the tasks
    spawner.must_spawn(blink_task(onboard_led));

    spawner.must_spawn(light_task(
        left_mosi,
        left_peri,
        left_rxdma,
        left_txdma,
        right_mosi,
        right_peri,
        right_rxdma,
        right_txdma,
        loudness_rx,
    ));

    spawner.must_spawn(fft_task(mic_rx, loudness_tx));

    // TODO: oneshot/confvar to wait until the lights and FFT are configured
    debug!("waiting for part 1");
    Timer::after_secs(3).await;
    debug!("spawning tasks part 2");

    spawner.must_spawn(mic_task(mic_adc, mic_pin, mic_tx));

    info!("all tasks started");
}
