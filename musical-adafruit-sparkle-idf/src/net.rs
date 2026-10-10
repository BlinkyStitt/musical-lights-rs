//! Standalone 400-pixel net, with its onboard 48 kHz microphone.
use crate::{capture, debug::log_stack_high_water_mark};
use esp_idf_svc::hal::{
    gpio::{Gpio25, Gpio26, Gpio33},
    i2s::I2S0,
    peripherals::Peripherals,
};
use musical_lights_core::{
    audio::{
        loudness::{LoudnessMeter, SoundField},
        parse_i2s_16_bit_mono_to_f32_array,
        visual::{DisplaySnapshot, VisualGain, PANEL_ROWS},
        Samples,
    },
    errors::MyError,
    fps::FpsTracker,
    lights::Gradient,
    logging::{error, info},
};
use once_cell::sync::Lazy;
use smart_leds::{
    brightness,
    colors::BLACK,
    gamma,
    hsv::{hsv2rgb, Hsv},
};
use smart_leds_trait::SmartLedsWrite;
use static_cell::ConstStaticCell;
use std::{
    iter::repeat_n,
    sync::Mutex,
    thread::{self, sleep},
    time::{Duration, Instant},
};
use ws2812_esp32_rmt_driver::{driver::color::LedPixelColorImpl, LedPixelEsp32Rmt, Ws2812Esp32Rmt};
const NUM_FIBONACCI_NEOPIXELS: usize = 400;
const FPS_TARGET: f32 = 55.5;
const I2S_SAMPLE_SIZE: usize = 768;
const I2S_U8_BUFFER_SIZE: usize = I2S_SAMPLE_SIZE * size_of::<i16>();
const PIXELS_PER_ROW: usize = 20;
const _: () = assert!(PANEL_ROWS * PIXELS_PER_ROW == NUM_FIBONACCI_NEOPIXELS);
const MY_BAND_MAX: u8 = 128;
#[derive(Clone, Copy)]
struct PanelAudio {
    snapshot: DisplaySnapshot<PANEL_ROWS>,
    origin: Option<Instant>,
    failed: bool,
}
static PANEL_AUDIO: Lazy<Mutex<PanelAudio>> = Lazy::new(|| {
    Mutex::new(PanelAudio {
        snapshot: DisplaySnapshot::new(0.0),
        origin: None,
        failed: false,
    })
});

pub fn run() -> eyre::Result<()> {
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();
    info!("NUM LEDS: {NUM_FIBONACCI_NEOPIXELS}");
    let peripherals = Peripherals::take()?;
    let pins = peripherals.pins;
    let lights = thread::Builder::new()
        .name("blink_neopixels".into())
        .stack_size(16_000)
        .spawn(move || {
            let mut onboard = Ws2812Esp32Rmt::new(pins.gpio2)?;
            let mut external = AdafruitNet::new(pins.gpio22)?;
            blink_neopixels_task(&mut onboard, &mut external)
                .inspect_err(|err| error!("Error in blink_neopixels_task: {err:?}"))
        })?;
    let mic = thread::Builder::new()
        .name("mic".into())
        .stack_size(16_000)
        .spawn(move || {
            mic_task(peripherals.i2s0, pins.gpio26, pins.gpio33, pins.gpio25).inspect_err(|err| {
                error!("Error in mic task: {err}");
                if let Ok(mut state) = PANEL_AUDIO.lock() {
                    state.failed = true;
                }
            })
        })?;
    // Let the renderer clear the LEDs if capture fails before returning its error.
    let audio_result = mic.join().unwrap();
    let light_result = lights.join().unwrap();
    audio_result?;
    light_result
}
/// I expected this to be GRB, but apparently the nets are RGB.
pub type AdafruitNet<'a> =
    LedPixelEsp32Rmt<'a, smart_leds::RGB<u8>, LedPixelColorImpl<3, 0, 1, 2, 255>>;

fn blink_neopixels_task(
    neopixel_onboard: &mut Ws2812Esp32Rmt<'_>,
    neopixel_external: &mut AdafruitNet<'_>,
) -> eyre::Result<()> {
    let palette = Gradient::<NUM_FIBONACCI_NEOPIXELS>::new_greg_caitlin_wedding();
    let response = crate::light_profile::led_response()?;
    info!("LED response measured: {}", response.is_measured());
    let started = Instant::now();
    let interval = Duration::from_secs_f32(1.0 / FPS_TARGET);
    let mut pixels = [BLACK; NUM_FIBONACCI_NEOPIXELS];
    let mut fps = FpsTracker::new("pixel");
    loop {
        let tick = Instant::now();
        let state = *PANEL_AUDIO.lock().map_err(|_| MyError::PoisonLock)?;
        if state.failed {
            neopixel_external.write(repeat_n(BLACK, NUM_FIBONACCI_NEOPIXELS))?;
            eyre::bail!("audio input failed; panel stopped");
        }
        let audio_time = state
            .origin
            .map_or(0.0, |origin| origin.elapsed().as_secs_f64());
        let levels = state.snapshot.frame(audio_time).levels;
        for (i, pixel) in pixels.iter_mut().enumerate() {
            // Preserve the 8/255 ambient light intent and 128 drive cap.
            let light = (8.0 + (MY_BAND_MAX as f32 - 8.0) * levels[i / PIXELS_PER_ROW]) / 255.0;
            *pixel = response.encode(palette.colors[i] * light, MY_BAND_MAX);
        }
        let elapsed = started.elapsed().as_secs_f64();
        let offset = ((elapsed * f64::from(FPS_TARGET) / 4.0 / PIXELS_PER_ROW as f64) as usize
            * PIXELS_PER_ROW)
            % NUM_FIBONACCI_NEOPIXELS;
        neopixel_external.write(pixels[offset..].iter().chain(&pixels[..offset]).copied())?;
        let hue = (elapsed * f64::from(FPS_TARGET)) as u64 as u8;
        neopixel_onboard.write(brightness(
            gamma(
                [hsv2rgb(Hsv {
                    hue,
                    sat: 255,
                    val: 255,
                })]
                .into_iter(),
            ),
            8,
        ))?;
        fps.tick();
        sleep(interval.saturating_sub(tick.elapsed()));
    }
}

fn mic_task(i2s: I2S0, bclk: Gpio26, ws: Gpio33, din: Gpio25) -> eyre::Result<()> {
    info!("Start I2S mic!");

    static I2S_BUF: ConstStaticCell<[u8; I2S_U8_BUFFER_SIZE]> =
        ConstStaticCell::new([0u8; I2S_U8_BUFFER_SIZE]);
    let i2s_u8_buf = I2S_BUF.take();
    info!("i2s_buffer created");

    static I2S_SAMPLE_BUF: ConstStaticCell<Samples<I2S_SAMPLE_SIZE>> =
        ConstStaticCell::new(Samples([0.0; I2S_SAMPLE_SIZE]));
    let i2s_sample_buf = I2S_SAMPLE_BUF.take();
    info!("i2s_sample_buf created");

    let calibration = crate::light_profile::input_calibration()?;
    info!(
        "Microphone scale: {} Pa/unit, measured: {}",
        calibration.pascals_per_unit(),
        calibration.is_measured()
    );
    let mut meter = LoudnessMeter::new(calibration, SoundField::Free);
    let mut gain = VisualGain::default();
    let mut snapshot = DisplaySnapshot::new(0.0);
    let mut sample_index = 0u64;
    let mut i2s_driver = capture::Capture::new(i2s, bclk, ws, din, I2S_SAMPLE_SIZE)?;
    let origin = Instant::now();
    info!("I2S enabled: 48000 Hz, left channel, signed 16-bit PCM");
    log_stack_high_water_mark("mic", None);

    loop {
        i2s_driver.read_exact(i2s_u8_buf)?;

        // TODO: compile time option to choose between 16-bit or 24-bit audio
        parse_i2s_16_bit_mono_to_f32_array(i2s_u8_buf, &mut i2s_sample_buf.0);

        meter.push_pcm(&i2s_sample_buf.0, sample_index, |frame| {
            snapshot.push(
                frame.sample_index as f64 / 48_000.0,
                gain.map(&frame).panel_rows,
                false,
            );
        })?;
        sample_index += I2S_SAMPLE_SIZE as u64;
        i2s_driver.check_continuity()?;
        // Only visual state may be superseded; all audio and attacks were consumed.
        if let Ok(mut state) = PANEL_AUDIO.try_lock() {
            *state = PanelAudio {
                snapshot,
                origin: Some(origin),
                failed: false,
            };
        }
    }
}
