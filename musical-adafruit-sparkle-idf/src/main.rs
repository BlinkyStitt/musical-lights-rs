//! TODO: totally unsure of prioritites. i should just start with everything on the same priority probably
//! TODO: move this to a lib and then have multiple bins. one for the hat, one for the necklace, one for the net, etc. they should try to share code in the crate or in musical-lights-core.
// #![feature(thread_sleep_until)]

mod capture;
mod debug;
mod light_patterns;
mod light_profile;
mod sensor_uart;

use esp_idf_svc::hal::{
    gpio::{AnyIOPin, Gpio25, Gpio26, Gpio33},
    i2s::I2S0,
    peripherals::Peripherals,
    uart::{config::Config, UartDriver},
    units::Hertz,
};
use musical_lights_core::{
    audio::{
        loudness::{LoudnessMeter, SoundField},
        parse_i2s_16_bit_mono_to_f32_array,
        visual::{DisplaySnapshot, VisualGain, PANEL_ROWS},
        Samples,
    },
    compass::{Coordinate, Magnetometer},
    errors::MyError,
    fps::FpsTracker,
    lights::Gradient,
    logging::{debug, error, info, warn},
    message::{Message, PeerId, MESSAGE_BAUD_RATE},
    orientation::Orientation,
    remap,
};
use once_cell::sync::Lazy;
use smart_leds::colors::BLACK;
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    RGB8,
};
use smart_leds_trait::SmartLedsWrite;
use static_cell::ConstStaticCell;
use std::{iter::repeat_n, time::Instant};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread::{self, sleep},
    time::Duration,
};
use ws2812_esp32_rmt_driver::{driver::color::LedPixelColorImpl, LedPixelEsp32Rmt, Ws2812Esp32Rmt};

use crate::debug::log_stack_high_water_mark;
use crate::{
    light_patterns::{clock, compass, flashlight, rainbow},
    sensor_uart::{UartFromSensors, UartToSensors},
};

const MAX_PEERS: usize = 4;

/// theres 1 built in neopixel. its useful for debugging, but we should maybe have an option to skip it
const NUM_ONBOARD_NEOPIXELS: usize = 1;

/// fibonacci panel is 256
/// the 1x1 net is 20x20 == 400 pixels. the watchdog timer is throwing if I2S_SAMPLE_SIZE is 512. thats just too many ffts
/// the 1x2 net is 20x40 == 800 pixels.
const NUM_FIBONACCI_NEOPIXELS: usize = 400;

/// The time-varying loudness model requires this analysis rate.
const I2S_SAMPLE_RATE_HZ: u32 = 48_000;

// TODO: if this isn't perfectly divisible, then the target will probably be off. maybe make it easy to round up?
const FPS_TARGET: f32 = 55.5;

/// DMA read size; filter and integration state continue across every read.
const I2S_SAMPLE_SIZE: usize = 768;

/// TODO: with 24-bit audio, this should use `size_of::<i32>`
const I2S_U8_BUFFER_SIZE: usize = I2S_SAMPLE_SIZE * size_of::<i16>();

// The 20×20 panel retains one full 20-pixel row per output.
const AGGREGATED_OUTPUTS: usize = PANEL_ROWS;
const PIXELS_PER_ROW: usize = 20;

const _SAFETY_CHECKS: () = {
    // assert!(FFT_INPUTS % I2S_SAMPLE_SIZE == 0);
    assert!(I2S_SAMPLE_SIZE > 1);
    assert!(AGGREGATED_OUTPUTS * PIXELS_PER_ROW == NUM_FIBONACCI_NEOPIXELS);
    // assert!(I2S_SAMPLE_OVERLAP == 1 || I2S_SAMPLE_OVERLAP == 2 || I2S_SAMPLE_OVERLAP == 4)
};

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

/// TODO: add a lot more to this
/// TODO: max capacity on the HashMap?
/// TODO: include self in the main peer_coordinate map?
/// TODO: add a color pallet here?
#[derive(Clone, Default, Debug)]
struct State {
    orientation: Orientation,
    magnetometer: Option<Magnetometer>,
    /// TODO: should this be a bearing along with the coordinate?
    self_coordinate: Option<Coordinate>,
    self_id: Option<PeerId>,
    /// TODO: max peers is so that we dont run out of ram. what does this do when its full though?
    /// TODO: do we want their coordinates, or something else like our bearing to them?
    peer_coordinate: heapless::index_map::FnvIndexMap<PeerId, Coordinate, MAX_PEERS>,
    /// the SystemTime is the time from the GPS and the Instant is when we received it.
    /// TODO: There's probably a small offset needed. make a helper for adding them?
    /// TODO: think more about this
    time: Option<(std::time::SystemTime, Instant)>,
}

fn main() -> eyre::Result<()> {
    // It is necessary to call this function once. Otherwise some patches to the runtime
    // implemented by esp-idf-sys might not link properly. See https://github.com/esp-rs/esp-idf-template/issues/71
    esp_idf_svc::sys::link_patches();

    // Bind the log crate to the ESP Logging facilities
    esp_idf_svc::log::EspLogger::initialize_default();

    info!("Hello, world!");
    info!("NUM LEDS: {NUM_FIBONACCI_NEOPIXELS}");

    // TODO: static_cell? arc? something else? LazyLock from std? RwLock?
    static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

    /*
    // TODO: what size? do we need an arc around this? or is a static okay?
    static PONG_RECEIVED: AtomicBool = AtomicBool::new(false);
    */

    let peripherals = Peripherals::take()?;
    let pins = peripherals.pins;

    // TODO: use this for anything? <https://github.com/esp-rs/esp-idf-svc/blob/master/examples/eventloop.rs>
    // let sysloop = EspSystemEventLoop::take();

    // TODO: use timer service instead of std sleep?
    // let timer_service = EspTaskTimerService::new()?;

    // TODO: do something with nvs. like set up signing keys
    // let nvs = EspDefaultNvsPartition::take()?;

    // TODO: set up bluetooth or wifi. not sure what to do with them. but they give us a true rng

    /*
    // TODO: this baud rate needs to match the sensor board
    let uart1_config = Config::default().baudrate(Hertz(MESSAGE_BAUD_RATE));

    let uart_to_sensors: UartDriver = UartDriver::new(
        peripherals.uart1,
        pins.gpio9,
        pins.gpio10,
        Option::<AnyIOPin>::None,
        Option::<AnyIOPin>::None,
        &uart1_config,
    )?;

    // you need `into_split` and not `split` so that the halves can be sent to different threads
    let (uart_to_sensors_tx, uart_to_sensors_rx) = uart_to_sensors.into_split();

    // TODO: pick proper sizes for these buffers. 256 should work, but its not correct
    // TODO: box the usart sensor things? its got some big buffers inside of it
    // TODO: const new functions for these so we can statically allocate them?
    let mut uart_from_sensors: Box<UartFromSensors<'_, 256, 256>> =
        Box::new(UartFromSensors::new(uart_to_sensors_rx));
    let mut uart_to_sensors: Box<UartToSensors<'_, 256>> =
        Box::new(UartToSensors::new(uart_to_sensors_tx));
    */

    // TODO: do we need two cores? how do we set them up?

    // TODO: optionally turn on wifi so we can query shazam

    // unsafe { heap_caps_dump_all() };

    // TODO: is there a better way to do signals? i think there probably is something built into esp32

    // TODO: how do we spawn on a specific core? though the spi driver should be able to use DMA
    // TODO: thread priority?
    let blink_neopixels_handle = thread::Builder::new()
        .name("blink_neopixels".to_string())
        // The linear palette alone uses 4,800 bytes, above IDF's default
        // pthread stack. Leave room for the output buffer and renderer calls.
        .stack_size(16_000)
        .spawn(move || {
            let mut neopixel_onboard = Ws2812Esp32Rmt::new(pins.gpio2)?;
            let mut neopixel_external2 = AdafruitNet::new(pins.gpio22)?;

            blink_neopixels_task(&mut neopixel_onboard, &mut neopixel_external2, &STATE)
                .inspect_err(|err| {
                    error!("Error in blink_neopixels_task");
                    error!("{err:?}");
                })
        })?;

    // TODO: make sure this has the highest priority?
    let mic_handle = thread::Builder::new()
        .name("mic".to_string())
        .stack_size(16_000)
        .spawn(move || {
            mic_task(peripherals.i2s0, pins.gpio26, pins.gpio33, pins.gpio25).inspect_err(|err| {
                error!("Error in mic task: {err}");
                if let Ok(mut state) = PANEL_AUDIO.lock() {
                    state.failed = true;
                }
            })
        })?;

    /*
    // TODO: use the channels that come with idf instead? should they be static? what size should we do? we need to measure the high water mark on these too?
    let (message_for_sensors_tx, message_for_sensors_rx) = flume::bounded(4);

    let read_from_sensors_handle = thread::Builder::new()
        .name("read_from_sensors".to_string())
        .spawn(move || {
            read_from_sensors_task(
                message_for_sensors_tx,
                &PONG_RECEIVED,
                &STATE,
                &mut uart_from_sensors,
            )
            .inspect_err(|err| {
                error!("Error in sensor_rx_task");
                error!("{err:?}");
            })
        })?;

    let send_to_sensors_handle = thread::Builder::new()
        .name("send_to_sensors".to_string())
        .spawn(move || {
            send_to_sensors_task(
                message_for_sensors_rx,
                &PONG_RECEIVED,
                uart_to_sensors.as_mut(),
            )
            .inspect_err(|err| {
                error!("Error in sensor_tx_task: {err}");
            })
        })?;
    */

    mic_handle.join().unwrap().unwrap();
    blink_neopixels_handle.join().unwrap().unwrap();

    // TODO: turn this on once we actually have more sensors plugged in
    // read_from_sensors_handle.join().unwrap().unwrap();
    // send_to_sensors_handle.join().unwrap().unwrap();

    Ok(())
}

/// I expected this to be GRB, but apparently the nets are RGB.
pub type AdafruitNet<'a> =
    LedPixelEsp32Rmt<'a, smart_leds::RGB<u8>, LedPixelColorImpl<3, 0, 1, 2, 255>>;

fn blink_neopixels_task(
    neopixel_onboard: &mut Ws2812Esp32Rmt<'_>,
    neopixel_external: &mut AdafruitNet<'_>,
    _state: &'static Mutex<State>,
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

/// TODO: should state be in a RwLock? should it be a watch channel instead that we send things to and some other task does work on it?
fn read_from_sensors_task<const RAW_BUF_BYTES: usize, const COB_BUF_BYTES: usize>(
    message_to_sensors: flume::Sender<Message>,
    pong_received: &'static AtomicBool,
    state: &'static Mutex<State>,
    uart_from_sensors: &mut UartFromSensors<'static, RAW_BUF_BYTES, COB_BUF_BYTES>,
) -> eyre::Result<()> {
    let process_message = |msg| {
        info!("received msg: {msg:?}");

        match msg {
            Message::Ping => {
                // i don't think we actually see pings on this side, but it works for now
                message_to_sensors
                    .send(Message::Pong)
                    .expect("failed to respond with pong");
            }
            Message::Pong => {
                // TODO: should this just be part of the state instead? Really not sure about Ordering
                pong_received.store(true, Ordering::SeqCst);
            }
            Message::Orientation(orientation) => {
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.orientation = orientation;
            }
            Message::Magnetometer(mag) => {
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.magnetometer = Some(mag);
            }
            Message::GpsTime(gps_time) => {
                warn!("not sure what to do with gps time. maybe instead connect to the pulse-per-second line? but we don't have many pins available");
            }
            Message::PeerCoordinate(peer_id, coordinate) => {
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                if let Err((peer_id, peer_coord)) =
                    state.peer_coordinate.insert(peer_id, coordinate)
                {
                    error!("too many peers: {peer_id:?} @ {peer_coord:?}");
                };
            }
            Message::SelfCoordinate(coordinate) => {
                // TODO: on startup, the key needs to be passed to the sensor board so it can sign radio messages
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.self_coordinate = Some(coordinate);
            }
        }

        // TODO: should we send state into a watch channel? or is a mutex enough? arcswap maybe?
        Ok::<_, MyError>(())
    };

    // TODO: no idea what the timeout should be
    // TODO: i think maybe we should use the async reader? we don't want a timeout
    if let Err(err) = uart_from_sensors.read_loop(process_message, 10) {
        error!("failed reading from uart");
        error!("{err:?}");
    };

    // TODO: once the read loop exits, what should we do? it exits when it isn't connected

    // TODO: ONLY in debug mode, run a mock loop. otherwise just set the state to something useful
    uart_from_sensors.mock_loop(process_message)?;

    Ok(())
}

fn send_to_sensors_task<const N: usize>(
    message_to_sensors: flume::Receiver<Message>,
    pong_received: &'static AtomicBool,
    uart_to_sensors: &mut UartToSensors<'static, N>,
) -> eyre::Result<()> {
    // send a ping on an interval until we get a pong. then continue
    while !pong_received.load(Ordering::SeqCst) {
        info!("sending ping");
        uart_to_sensors.write(&Message::Ping)?;
        sleep(Duration::from_millis(100));
    }

    // listen on a channel to see if we need to send anything more. i don't think we will
    loop {
        let message = message_to_sensors.recv()?;

        info!("writing to uart");

        // TODO: if writing to the uart fails, we should just log the error but don't crash the app
        uart_to_sensors.write(&message)?;
    }
}
