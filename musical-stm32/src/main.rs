#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

use core::iter::repeat;

use embassy_executor::Spawner;
use embassy_futures::join::join;
use embassy_stm32::adc::{Adc, SampleTime};
use embassy_stm32::gpio::{Level, Output, Speed};
use embassy_stm32::peripherals::{
    ADC1, DMA1_CH4, DMA2_CH2, IWDG, PA0, PB15, PB5, SPI1, SPI2,
};
use embassy_stm32::spi::{Config as SpiConfig, Spi};
use embassy_stm32::time::mhz;
use embassy_stm32::wdg::IndependentWatchdog;
use embassy_stm32::Config;
use embassy_sync::blocking_mutex::raw::ThreadModeRawMutex;
use embassy_sync::channel::{Channel, Receiver, Sender};
use embassy_time::{Timer};
use itertools::repeat_n;
use micromath::F32Ext;
use musical_lights_core::lights::{color_correction, color_order::GRB, DancingLights, Gradient};
use musical_lights_core::{
    audio::{
        AWeighting, AggregatedAmplitudesBuilder, AudioBuffer, ExponentialScaleAmplitudes,
        ExponentialScaleBuilder, FFT,
    },
    logging::{debug, info, trace},
    remap,
    windows::HanningWindow,
};
use smart_leds::colors::{BLACK, BLUE, RED};
use smart_leds::RGB8;
use {defmt_rtt as _, panic_probe as _};

const MIC_SAMPLES: usize = 512;
const FFT_INPUTS: usize = 2048;
const MATRIX_X: usize = 8;
const MATRIX_Y: usize = 32;

/// oh. this is why they packed it in the first Complex. Because it's helpful to keep connected to the samples
/// TODO: i don't think the micro controller actually samples this fast! we need a dedicated chip. we also need to time it!
const SAMPLE_RATE: f32 = 44_100.0;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;
const MATRIX_N: usize = MATRIX_X * MATRIX_Y;

const MATRIX_BUFFER: usize = MATRIX_N * 12;

// const VREF_NOMINAL: u16 = 3300;
// const VREFINT_CALIBRATED: u16 = 1230;

#[embassy_executor::task]
pub async fn blink_task(mut led: Output<'static>) {
    loop {
        debug!("high");
        led.set_high();
        Timer::after_millis(1000).await;

        debug!("low");
        led.set_low();
        Timer::after_millis(5000).await;
    }
}

#[embassy_executor::task]
async fn mic_task(
    mic_adc: ADC1,
    mut mic_pin: PA0,
    tx: Sender<'static, ThreadModeRawMutex, f32, MIC_SAMPLES>,
    // vref_nominal: u16,
    // vrefint_calibrated: u16,
) {
    // TODO: i kind of wish i'd ordered the i2s mic
    let mut adc = Adc::new(mic_adc);

    // TODO: what resolution?
    let adc_resolution = 12;

    let range = 2.0f32.powi(adc_resolution) - 1.0;

    // 100 mHz processor
    // TODO: how long should we sample?
    adc.set_sample_time(SampleTime::CYCLES3);
    // TODO: impl From<u8> for Resolution? or maybe have "bits" and "range" functions on Resolution
    adc.set_resolution(embassy_stm32::adc::Resolution::BITS12);

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

        // trace!("mic u16: {}", sample);

        // scale 0-4095 to millivolts
        // TODO: is this right? it worked on the discovery board, but .value() isn't available on the blackpill
        // let sample_mv = (sample * vrefint.value() as u32 / vref as u32) * 3300 / 4095;

        // 0-centered. i don't think is totally correct. we shlould be converting to voltage
        let sample = remap(sample as f32, 0.0, range, -1.0, 1.0);

        // trace!("mic f32: {}", sample);

        tx.send(sample).await;

        // TODO: how accurate is this timer? we would probably do better with a smarter cheap and reading samples over i2s or spi
        // 44.1kHz = 22,676 nanoseconds
        // TODO: maybe we should do a blocking delay and then a yield every 512 samples? this needs to be accurate or the frequencies won't be correct
        Timer::after_nanos(22_676).await;
    }
}

#[embassy_executor::task]
async fn fft_task(
    mic_rx: Receiver<'static, ThreadModeRawMutex, f32, MIC_SAMPLES>,
    loudness_tx: Sender<'static, ThreadModeRawMutex, ExponentialScaleAmplitudes<MATRIX_Y>, 16>,
) {
    // create windows and weights and everything before starting any tasks
    let mut audio_buffer: AudioBuffer<MIC_SAMPLES, FFT_INPUTS> = AudioBuffer::new();

    // TODO: i need custom weighting. the microphone dynamic gain might not work well with this
    let equal_loudness_weighting = AWeighting::new(SAMPLE_RATE);
    // let equal_loudness_weighting = FlatWeighting;

    let fft: FFT<FFT_INPUTS, FFT_OUTPUTS> = FFT::new_with_window_and_weighting::<
        HanningWindow<FFT_INPUTS>,
        _,
    >(equal_loudness_weighting);

    // TODO: figure out why 20-400 are too low. probably a weighting too strong and adc timings/sample rate not being correct
    let scale_builder =
        ExponentialScaleBuilder::<FFT_OUTPUTS, MATRIX_Y>::new(80.0, 10_000.0, SAMPLE_RATE);

    // TODO: make this work again
    // let scale_builder = BarkScaleBuilder::new(SAMPLE_RATE);

    loop {
        let sample = mic_rx.receive().await;

        // let millivolts = convert_to_millivolts(sample, vrefint_sample);
        // trace!("mic: {} mV", millivolts);

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

// pub type LedWriter<'a> = ws2812_async::Ws2812<Spi<'a, SPI1, DMA2_CH2, DMA2_CH0>, { MATRIX_N * 12 }>;

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
    left_txdma: DMA2_CH2,
    right_mosi: PB15,
    right_peri: SPI2,
    right_txdma: DMA1_CH4,
    loudness_rx: Receiver<'static, ThreadModeRawMutex, ExponentialScaleAmplitudes<MATRIX_Y>, 16>,
) {
    let mut spi_config = SpiConfig::default();

    // TODO: this setup feels like it should be inside leds::Ws2812. like frequency check that its >2 and <3.8
    spi_config.frequency = mhz(38) / 10u32; // 3.8MHz
    spi_config.mode = embassy_stm32::spi::MODE_0;

    let spi_left = Spi::new_txonly_nosck(left_peri, left_mosi, left_txdma, spi_config);
    let spi_right =
        Spi::new_txonly_nosck(right_peri, right_mosi, right_txdma, spi_config);

    let mut led_left = ws2812_async::Ws2812::<_, { MATRIX_BUFFER }>::new(spi_left);
    let mut led_right = ws2812_async::Ws2812::<_, { MATRIX_BUFFER }>::new(spi_right);

    // do a test pattern that makes it easy to tell if RGB is set up correctly and the panels on are on the correct sides
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

    let test_iter = |fill_color: RGB8| {
        TEST_PATTERN
            .iter()
            .copied()
            .chain(repeat_n(fill_color, MATRIX_X * 2))
            .chain(repeat(BLACK))
            .take(MATRIX_N)
    };

    // do a test pattern and then fill one panel with red and the other with blue. this makes it easy to tell if they got plugged in correctly
    let test_left_f = led_left.write(color_corrected_matrix(test_iter(BLUE)));
    let test_right_f = led_right.write(color_corrected_matrix(test_iter(RED)));

    let (left, right) = join(test_left_f, test_right_f).await;

    left.unwrap();
    right.unwrap();

    Timer::after_secs(2).await;

    let gradient = Gradient::new_mermaid();

    // TODO: setup seems to crash the program. blocking code must not be done correctly :(
    // TODO: how many ticks per decay?
    let mut dancing_lights = DancingLights::<MATRIX_X, MATRIX_Y, MATRIX_N>::new(gradient, 0.975);

    // TODO: how should we use frame_number to offset the animation?
    // TODO: track framerate
    let mut frame_number: usize = 0;
    let y_offset = 0;

    loop {
        // TODO: i want to draw with a framerate, but we draw every time we receive. think about this more
        let loudness = loudness_rx.receive().await;

        dancing_lights.update(loudness.0);

        // TODO: how fast should we scroll? we used to do this based off time, not frame count.
        // y_offset = frame_number / 8;

        // TODO: why do we need copied? can we avoid it?
        let left_iter = dancing_lights.iter_flipped_x(y_offset).copied();
        let right_iter = dancing_lights.iter(y_offset).copied();

        // TODO: don't just repeat. use gradient instead!
        let fill_left_f = led_left.write(color_corrected_matrix(left_iter));
        let fill_right_f = led_right.write(color_corrected_matrix(right_iter));

        let (left, right) = join(fill_left_f, fill_right_f).await;

        left.unwrap();
        right.unwrap();

        frame_number += 1;

        trace!("frame #{}", frame_number);
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
    // default clocks: 0.000000 DEBUG rcc: Clocks { sys: Hertz(16000000), pclk1: Hertz(16000000), pclk1_tim: Hertz(16000000), pclk2: Hertz(16000000), pclk2_tim: Hertz(16000000), hclk1: Hertz(16000000), hclk2: Hertz(16000000), hclk3: Hertz(16000000), plli2s1_q: None, plli2s1_r: None, pll1_q: None, rtc: Some(Hertz(32000)) }
    let peripheral_config = Config::default();
    // TODO: configure system clock to be faster
    // TODO: configure adc to be faster, too
    // TODO: this board is simlar <https://github.com/embassy-rs/embassy/blob/main/examples/stm32f334/src/bin/adc.rs>, but our board works differently
    // config.rcc.sysclk = Some(mhz(64));
    // config.rcc.hclk = Some(mhz(64));
    // config.rcc.pclk1 = Some(mhz(32));
    // config.rcc.pclk2 = Some(mhz(64));
    // config.rcc.adc = Some(AdcClockSource::Pll(Adcpres::DIV1));

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
    // let left_rxdma = p.DMA2_CH0;
    let left_txdma = p.DMA2_CH2;

    // let right_rxdma = p.DMA1_CH3;
    let right_txdma = p.DMA1_CH4;

    // // start the watchdog
    // let wdg = IndependentWatchdog::new(p.IWDG, 5_000_000);
    // spawner.must_spawn(watchdog_task(wdg));

    // set up pins
    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low);

    let mic_adc = p.ADC1;
    let mic_pin = p.PA0;

    // TODO: pin_alias?

    // channel for mic samples -> FFT
    // TODO: what size channel? need to measure high water mark
    static MIC_CHANNEL: Channel<ThreadModeRawMutex, f32, 512> = Channel::new();
    let mic_tx = MIC_CHANNEL.sender();
    let mic_rx = MIC_CHANNEL.receiver();

    // channel for FFT -> LEDs
    // TODO: what size channel? need to measure high water mark
    static LOUDNESS_CHANNEL: Channel<ThreadModeRawMutex, ExponentialScaleAmplitudes<MATRIX_Y>, 16> =
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
        left_txdma,
        right_mosi,
        right_peri,
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
