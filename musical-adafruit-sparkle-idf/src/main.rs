//! TODO: totally unsure of prioritites. i should just start with everything on the same priority probably
//! TODO: move this to a lib and then have multiple bins. one for the hat, one for the necklace, one for the net, etc. they should try to share code in the crate or in musical-lights-core.
#![feature(cmp_minmax, slice_as_array, type_alias_impl_trait)]
// #![feature(thread_sleep_until)]

mod debug;
mod light_patterns;
mod sensor_uart;

use biski64::Biski64Rng;
use esp_idf_svc::{
    hal::{
        gpio::{AnyIOPin, Gpio25, Gpio26, Gpio33},
        i2s::{self, I2sDriver, I2S0},
        prelude::Peripherals,
        uart::{config::Config, UartDriver},
        units::Hertz,
    },
    io::Read,
};
use esp_idf_sys::{bootloader_random_disable, bootloader_random_enable, esp_random};
use musical_lights_core::{
    audio::{parse_i2s_16_bit_mono_to_f32_array, AggregatedBins, BarkBank, Samples},
    compass::{Coordinate, Magnetometer},
    errors::MyError,
    fps::FpsTracker,
    lights::Bands,
    logging::{debug, error, info, warn},
    message::{Message, PeerId, MESSAGE_BAUD_RATE},
    orientation::Orientation,
    windows::HanningWindow,
};
use once_cell::sync::Lazy;
use rand::RngCore;
use smart_leds::colors::BLACK;
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    RGB8,
};
use smart_leds_trait::SmartLedsWrite;
use static_cell::ConstStaticCell;
use std::thread::yield_now;
use std::time::Instant;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread::{self, sleep},
    time::Duration,
};
use ws2812_esp32_rmt_driver::Ws2812Esp32Rmt;

use crate::debug::log_stack_high_water_mark;
use crate::light_patterns::{loading, MicLoudnessPattern};
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

/// TODO: 44.1kHz? 48kHz? 96Khz?
const I2S_SAMPLE_RATE_HZ: u32 = 44100;

/// TODO: what size FFT? i want to have 4096, but 2048 is probably fine. the teensy had 1024 i think.
const FFT_INPUTS: usize = 4096;

/// TODO: not sure if this should be 1, 2, or 4
const I2S_SAMPLE_OVERLAP: usize = 4;

/// we wait for the i2s to give this many samples, then pass them to the fft for processing with some windowing over these and some older ones
/// different sample rates and FFT_INPUTS are a good idea here!
const I2S_SAMPLE_SIZE: usize = FFT_INPUTS / I2S_SAMPLE_OVERLAP;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

/// TODO: with 24-bit audio, this should use `size_of::<i32>`
const I2S_U8_BUFFER_SIZE: usize = I2S_SAMPLE_SIZE * size_of::<i16>();

const AGGREGATED_OUTPUTS: usize = 10;

/// TODO: the mic's floor is -90, but I think we should ignore under 60. or maybe even 30. but we need dbfs calculated correctly first!
const FLOOR_DB: f32 = -65.;
/// TODO: what should this be? whats the minimum range that we want?
const FLOOR_PEAK_DB: f32 = FLOOR_DB + 24.;

// TODO: 20/24 buckets don't fit inside of 256 or 400!
// TODO: do 10 buckets and have them be 2 wide and 1 tall? then we can show 20 frames?
// Y is currently set to 9 because the terminal logging looks better. but that should change to fit the actual leds
const DEBUGGING_Y: usize = 9;
const DEBUGGING_N: usize = AGGREGATED_OUTPUTS * DEBUGGING_Y;

const _SAFETY_CHECKS: () = {
    assert!(FFT_INPUTS % I2S_SAMPLE_SIZE == 0);
    assert!(I2S_SAMPLE_SIZE > 1);
    assert!(I2S_SAMPLE_OVERLAP == 1 || I2S_SAMPLE_OVERLAP == 2 || I2S_SAMPLE_OVERLAP == 4)
};

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
    peer_coordinate: heapless::FnvIndexMap<PeerId, Coordinate, MAX_PEERS>,
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
    info!("NUM LEDS: {}", NUM_FIBONACCI_NEOPIXELS);

    // TODO: static_cell? arc? something else? LazyLock from std? RwLock?
    static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

    // TODO: what size? do we need an arc around this? or is a static okay?
    static PONG_RECEIVED: AtomicBool = AtomicBool::new(false);

    let peripherals = Peripherals::take()?;
    let pins = peripherals.pins;

    // TODO: use this for anything? <https://github.com/esp-rs/esp-idf-svc/blob/master/examples/eventloop.rs>
    // let sysloop = EspSystemEventLoop::take();

    // TODO: use timer service instead of std sleep?
    // let timer_service = EspTaskTimerService::new()?;

    // TODO: do something with nvs. like set up signing keys
    // let nvs = EspDefaultNvsPartition::take()?;

    // TODO: set up bluetooth or wifi. not sure what to do with them. but they give us a true rng

    let mut neopixel_onboard = Ws2812Esp32Rmt::new(peripherals.rmt.channel0, pins.gpio2)?;
    // let mut neopixel_external1 = Ws2812Esp32Rmt::new(peripherals.rmt.channel1, pins.gpio21)?;
    let mut neopixel_external2 = Ws2812Esp32Rmt::new(peripherals.rmt.channel2, pins.gpio22)?;
    // let mut neopixel_external3 = Ws2812Esp32Rmt::new(peripherals.rmt.channel3, pins.gpio19)?;
    // let mut neopixel_external4 = Ws2812Esp32Rmt::new(peripherals.rmt.channel4, pins.gpio23)?;

    // TODO: this baud rate needs to match the sensory board
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

    // TODO: do we need two cores? how do we set them up?

    // TODO: optionally turn on wifi so we can query shazam

    // for using randomness, we could also turn on the bluetooth or wifi modules, but I don't have a use for them currently
    let seed_high;
    let seed_low;
    unsafe {
        // TODO: randome enable is only needed if wifi and bluetooth are both off
        bootloader_random_enable();
        seed_high = esp_random();
        seed_low = esp_random();
        bootloader_random_disable()
    };

    let seed: u64 = ((seed_high as u64) << 32) | (seed_low as u64);

    let mut rng_1 = Biski64Rng::from_seed_for_stream(seed, 0, 2);
    let mut rng_2 = Biski64Rng::from_seed_for_stream(seed, 1, 2);

    // TODO: where should we use this rng?
    let rng_1_hello = rng_1.next_u64();
    let rng_2_hello = rng_2.next_u64();
    debug!("rng {} {}", rng_1_hello, rng_2_hello);

    // unsafe { heap_caps_dump_all() };

    // TODO: is there a better way to do signals? i think there probably is something built into esp32
    let (mut fft_ready_tx, fft_ready_rx) = flume::bounded::<AggregatedBins<20>>(1);

    // TODO: how do we spawn on a specific core? though the spi driver should be able to use DMA
    // TODO: thread priority?
    let blink_neopixels_handle = thread::Builder::new()
        .name("blink_neopixels".to_string())
        .spawn(move || {
            blink_neopixels_task(
                &mut neopixel_onboard,
                &mut neopixel_external2,
                rng_1,
                &STATE,
                fft_ready_rx,
            )
            .inspect_err(|err| {
                error!("Error in blink_neopixels_task");
                error!("{err:?}");
            })
        })?;

    // TODO: is this a good idea? i want the light code running ASAP
    // yield_now();

    // TODO: make sure this has the highest priority?
    let mic_handle = thread::Builder::new()
        .name("mic".to_string())
        .stack_size(16_000)
        .spawn(move || {
            mic_task(
                peripherals.i2s0,
                pins.gpio26,
                pins.gpio33,
                pins.gpio25,
                &mut fft_ready_tx,
            )
            .inspect_err(|err| {
                error!("Error in mic task: {err}");
            })
        })?;

    // TODO: is this a good idea? i want the mic code running ASAP
    // yield_now();

    // TODO: use the channels that come with idf instead? should they be static? what size should we do? we need to measure the high water mark on these too
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

    mic_handle.join().unwrap().unwrap();
    read_from_sensors_handle.join().unwrap().unwrap();
    send_to_sensors_handle.join().unwrap().unwrap();

    Ok(())
}

// TODO: i'd really love to do this without locking state, but i think we need to.
fn blink_neopixels_task(
    neopixel_onboard: &mut Ws2812Esp32Rmt<'_>,
    neopixel_external: &mut Ws2812Esp32Rmt<'_>,
    mut rng: Biski64Rng,
    state: &'static Mutex<State>,
    audio_ready: flume::Receiver<AggregatedBins<20>>,
) -> eyre::Result<()> {
    info!("Start NeoPixel rainbow!");

    // TOOD: don't start randomly. use the current time (from the gps) so we are in perfect sync with the other art?
    let mut g_hue = rng.next_u32() as u8;

    // TODO: do we want these boxed? they are large. maybe they should be statics instead?
    static ONBOARD_DATA: ConstStaticCell<[RGB8; NUM_ONBOARD_NEOPIXELS]> =
        ConstStaticCell::new([BLACK; NUM_ONBOARD_NEOPIXELS]);
    let onboard_data = ONBOARD_DATA.take();

    // TODO: use embedded_graphics crate
    static FIBONACCI_DATA: ConstStaticCell<[RGB8; NUM_FIBONACCI_NEOPIXELS]> =
        ConstStaticCell::new([BLACK; NUM_FIBONACCI_NEOPIXELS]);
    let fibonacci_data = FIBONACCI_DATA.take();

    // TODO: for onboard, we should display a test pattern. 1 red flash, then 2 green flashes, then 3 blue flashes, then 4 white flashes
    // TODO: for fibonacci, we should display a test pattern of 1 red, 1 blank, 2 green, 1 blank, 3 blue, 1 blank, then 4 whites. then whole panel red

    let mut fps = Box::new(FpsTracker::new("pixel"));

    loop {
        // TODO: think more about this sleep/recv.
        // sleep_until will give us a consistent framerate. but we might show multiple frames for the same data
        // waiting until the fft is ready makes sense for the light patterns, but I'm not sure it makes sense for the others
        // the fft should update consistently regardless of mode and we don't want two frames of the same data, so i think i like the fft_ready.recv above
        // sleep_until(start + Duration::from_nanos(1_000_000_000 / 80));
        let loudness = audio_ready.recv()?;

        // TODO: convert loudness to u8s and Bands or just let it be?

        // let start = Instant::now();

        debug!("Hue: {g_hue}");

        // TODO: Hsl instead of Hsv?
        let base_hsv = Hsv {
            hue: g_hue,
            sat: 255,
            val: 255,
        };

        // TODO: gamme correct now?
        onboard_data[0] = hsv2rgb(base_hsv);

        // TODO: do something to force a faked state for the first 5 seconds. during that time, we should play the "startup" pattern
        // TODO: this clone is too slow, but a critical section mutex also shouldn't be held open for long
        let unlocked_state = state.lock().map_err(|_| MyError::PoisonLock)?;

        // TODO: have a way to smoothly transition between patterns
        // TODO: new random g_hue whenever the pattern changes?
        match unlocked_state.orientation {
            Orientation::FaceDown => {
                // state isn't needed in this orientation. drop it now
                drop(unlocked_state);

                flashlight(fibonacci_data.as_mut_slice());
            }
            Orientation::FaceUp => {
                // TODO: clone it into a box?
                compass(base_hsv, fibonacci_data.as_mut_slice(), &unlocked_state);

                drop(unlocked_state);
            }
            Orientation::LeftUp | Orientation::RightUp | Orientation::TopUp => {
                // TODO: some state might be useful here. clone just whats needed
                drop(unlocked_state);

                // TODO: if we have mic data, display one of the musical patterns
                rainbow(base_hsv, fibonacci_data.as_mut_slice());
            }
            Orientation::Unknown => {
                // TODO: cycle between different patterns
                loading(base_hsv, fibonacci_data.as_mut_slice(), &unlocked_state);

                drop(unlocked_state);
            }
            Orientation::TopDown => {
                // TODO: some state might be useful here. clone just whats needed
                drop(unlocked_state);

                clock(base_hsv, fibonacci_data.as_mut_slice());
            }
        }

        // TODO: check that this is the right gamma correction for our leds
        // TODO: dithering
        // TODO: the docs for brightness and gamma are confusing. they say opposite things unless I just can't read?
        neopixel_onboard.write(brightness(gamma(onboard_data.iter().cloned()), 8))?;

        // TODO: yield or watchdog reset?
        yield_now();

        // TODO: do we want the async driver? do we want write_no_copy?
        // TODO: this should be an embedded_graphics display i think. though the fibonacci disk is rather different from a grid
        // TODO: use embedded graphics matrix here instead of the simpler writer. I'm not sure the layout of the nets
        neopixel_external
            .write(brightness(gamma(fibonacci_data.iter().cloned()), 25))
            .unwrap();

        yield_now();

        // TODO: better to base on time or on frame counts? time means that we can run different hardware and they will match better
        g_hue = g_hue.wrapping_add(1);

        fps.tick();
    }
}

fn mic_task(
    i2s: I2S0,
    bclk: Gpio26,
    ws: Gpio33,
    din: Gpio25,
    audio_ready: &mut flume::Sender<AggregatedBins<20>>,
) -> eyre::Result<()> {
    info!("Start I2S mic!");

    static I2S_BUF: ConstStaticCell<[u8; I2S_U8_BUFFER_SIZE]> =
        ConstStaticCell::new([0u8; I2S_U8_BUFFER_SIZE]);
    let i2s_u8_buf = I2S_BUF.take();
    info!("i2s_buffer created");

    static I2S_SAMPLE_BUF: ConstStaticCell<Samples<I2S_SAMPLE_SIZE>> =
        ConstStaticCell::new(Samples([0.0; I2S_SAMPLE_SIZE]));
    let i2s_sample_buf = I2S_SAMPLE_BUF.take();
    info!("i2s_sample_buf created");

    let i2s_channel_cfg = i2s::config::Config::default()
        .frames_per_buffer(I2S_SAMPLE_SIZE as u32)
        .dma_buffer_count(4);

    // let i2s_clk_cfg = i2s::config::StdClkConfig::new(
    //     I2S_SAMPLE_RATE_HZ,
    //     i2s::config::ClockSource::Apll,
    //     i2s::config::MclkMultiple::M256, // TODO: there is no mclk pin attached though?
    // );
    let i2s_clk_cfg = i2s::config::StdClkConfig::from_sample_rate_hz(I2S_SAMPLE_RATE_HZ);

    // TODO: really not sure about mono or stereo. it seems like all the default setup uses stereo
    // 24 bit audio is padded to 32 bits. how do they pad the sign though?
    // TODO: do we want to use 8 or 16 or 24 bit audio?
    let i2s_slot_cfg = i2s::config::StdSlotConfig::philips_slot_default(
        i2s::config::DataBitWidth::Bits16,
        i2s::config::SlotMode::Mono,
    );

    let i2s_gpio_cfg = i2s::config::StdGpioConfig::default();

    // philips doesn't let us set the clocks
    // let i2s_config =
    //     i2s::config::StdConfig::philips(I2S_SAMPLE_RATE_HZ, i2s::config::DataBitWidth::Bits16);

    let i2s_config =
        i2s::config::StdConfig::new(i2s_channel_cfg, i2s_clk_cfg, i2s_slot_cfg, i2s_gpio_cfg);

    // TODO: do we want the mclk pin?
    // TODO: DMA? i think thats handled for us
    let mut i2s_driver = I2sDriver::new_std_rx(i2s, &i2s_config, bclk, din, None::<AnyIOPin>, ws)?;

    i2s_driver.rx_enable()?;
    info!("I2S mic driver enabled");

    // TODO: const setup
    let mut filter_bank = BarkBank::new(I2S_SAMPLE_RATE_HZ as f32);

    log_stack_high_water_mark("mic", None);

    loop {
        // TODO: read with a timeout? read_exact?
        // TODO: this isn't ever returning. what are we doing wrong with the init/config?
        i2s_driver.read_exact(i2s_u8_buf)?;
        yield_now();

        // trace!(
        //     "Read i2s: {} {} {} {} ...",
        //     i2s_u8_buf[0], i2s_u8_buf[1], i2s_u8_buf[2], i2s_u8_buf[3]
        // );

        // TODO: compile time option to choose between 16-bit or 24-bit audio
        parse_i2s_16_bit_mono_to_f32_array(i2s_u8_buf, &mut i2s_sample_buf.0);
        yield_now();

        // TODO: logging the i2s buffer was causing it to crash. i guess writing floats is hard
        // info!("num f32s: {}", samples.0.len());

        // trace!(
        //     "i2s_sample_buf: {} {} {} {} ...",
        //     i2s_sample_buf.0[0], i2s_sample_buf.0[1], i2s_sample_buf.0[2], i2s_sample_buf.0[3]
        // );

        // this passes by ref because they are coming out of a buffer that we need to re-use next loop
        // TODO: move most everything under this into a helper function so that we can test individual pieces easier
        let spectrum = filter_bank.push_samples(&i2s_sample_buf.0);
        yield_now();

        // TODO: actually do things with the buffer. maybe only if the size is %512 or %1024 or %2048
        // well we know the buffer has grown by 512. so we should just do it without bothering to track the size

        // info!("num_lights: {}", mic_loudness_tick.num_lights());
        info!("loudness: {:?}", &spectrum);
        yield_now();

        // TODO: beat detection?
        // TODO: what else? shazam? steve had some ideas

        // fps.tick();

        let mut aggregated_bins = AggregatedBins([0.0; 20]);
        aggregated_bins.0.copy_from_slice(spectrum);

        // notify blink_neopixels_task. that way instead of a timer we get the fastest FPS we can push without any delay.
        // TODO: is this the best way to notify the other thread to run? it might miss frames, but i don't think we actually want backpressure here
        // TODO: this needs to clone light_scale_outputs into a Box and then send that
        // TODO: how do we turn exponential_scale_outputs into light_scale_outputs, and do we even want to do that here? i think that might belong in the light task!
        if audio_ready.try_send(aggregated_bins).is_err() {
            // TODO: count how many times this errors?
            warn!("fft was faster than the pixels");
        }

        // TODO: this is too verbose. maybe this should take the log level as an arg? or only display once per second? maybe put this into the fps counter?
        // log_stack_high_water_mark("mic loop", None);
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
                    error!("too many peers: {:?} @ {:?}", peer_id, peer_coord);
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
    // TODO: this read loop is causing a stack overflow. how?!
    // TODO: i think maybe we should use the async reader? we don't want a timeout
    if let Err(err) = uart_from_sensors.read_loop(process_message, 10) {
        error!("failed reading from uart");
        error!("{err:?}");
    };

    // TODO: once the read loop exits, what should we do? it exits when it isn't connected

    // // TODO: stack overflow here?
    // // uart errored or disconnected
    // // TODO: ONLY in debug mode, run a mock loop. otherwise just set the state to something useful
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
