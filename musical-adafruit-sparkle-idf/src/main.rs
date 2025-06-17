//! TODO: totally unsure of prioritites. i should just start with everything on the same priority probably
#![feature(type_alias_impl_trait)]
#![feature(slice_as_array)]

mod debug;
mod light_patterns;
mod sensor_uart;

use biski64::Biski64Rng;
use esp_idf_svc::hal::task::thread::ThreadSpawnConfiguration;
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
    audio::{
        parse_i2s_24_bit_to_f32_array, AggregatedAmplitudesBuilder, AudioBuffer,
        ExponentialScaleBuilder, Samples, FFT,
    },
    compass::{Coordinate, Magnetometer},
    errors::MyError,
    fps::FpsTracker,
    logging::{debug, error, info, warn},
    message::{Message, PeerId, MESSAGE_BAUD_RATE},
    orientation::Orientation,
    windows::HanningWindow,
};
use once_cell::sync::Lazy;
use rand::RngCore;
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    RGB8,
};
use smart_leds_trait::SmartLedsWrite;
use std::thread::yield_now;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        RwLock,
    },
    thread::{self, sleep},
    time::Duration,
};
use ws2812_esp32_rmt_driver::Ws2812Esp32Rmt;

use crate::debug::log_stack_high_water_mark;
use crate::light_patterns::{loading, startup};
use crate::{
    light_patterns::{clock, compass, flashlight, rainbow},
    sensor_uart::{UartFromSensors, UartToSensors},
};

const NUM_ONBOARD_NEOPIXELS: usize = 1;
const NUM_FIBONACCI_NEOPIXELS: usize = 256;
/// TODO: this is probably too high once we have a bunch of other things going on. but lets try out two cores!
/// TODO: should this match our slowest sensor?
// const FPS_FIBONACCI_NEOPIXELS: u64 = 100;
/// TODO: 48kHz?
const I2S_SAMPLE_RATE_HZ: u32 = 48_000;

/// TODO: what size FFT? i want to have 4096, but
const FFT_INPUTS: usize = 4096;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

/// TODO: really not sure about this. i think it comes from dma sizes that i don't see how to control
const I2S_U8_BUFFER_SIZE: usize = I2S_SAMPLE_SIZE * size_of::<i32>();
/// TODO: how do we make sure this fits cleanly inside the fft inputs? and also that its not so big that it slows down
const I2S_SAMPLE_SIZE: usize = 512;

const _SAFETY_CHECKS: () = {
    assert!(FFT_INPUTS % I2S_SAMPLE_SIZE == 0);
};

/// TODO: add a lot more to this
/// TODO: max capacity on the HashMap?
/// TODO: include self in the main peer_coordinate map?
#[derive(Clone, Default, Debug)]
struct State {
    orientation: Orientation,
    magnetometer: Option<Magnetometer>,
    self_coordinate: Option<Coordinate>,
    self_id: Option<PeerId>,
    peer_coordinate: HashMap<PeerId, Coordinate>,
}

fn main() -> eyre::Result<()> {
    // It is necessary to call this function once. Otherwise some patches to the runtime
    // implemented by esp-idf-sys might not link properly. See https://github.com/esp-rs/esp-idf-template/issues/71
    esp_idf_svc::sys::link_patches();

    // Bind the log crate to the ESP Logging facilities
    esp_idf_svc::log::EspLogger::initialize_default();

    info!("Hello, world!");

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
    let mut neopixel_external = Ws2812Esp32Rmt::new(peripherals.rmt.channel1, pins.gpio22)?;

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
    let mut uart_from_sensors: Box<UartFromSensors<'_, 256, 256>> =
        Box::new(UartFromSensors::new(uart_to_sensors_rx));
    let mut uart_to_sensors: Box<UartToSensors<'_, 256>> =
        Box::new(UartToSensors::new(uart_to_sensors_tx));

    // TODO: do we need two cores? how do we set them up?

    // for using randomness, we could also turn on the bluetooth or wifi modules, but I don't have a use for them currently
    let seed_high;
    let seed_low;
    unsafe {
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

    // TODO: static? arc? something else?
    static STATE: Lazy<RwLock<State>> = Lazy::new(|| RwLock::new(State::default()));

    // TODO: is there a better way to do signals? i think there probably is something built into esp32
    let (mut fft_ready_tx, fft_ready_rx) = flume::bounded::<()>(1);

    let mut blink_neopixels_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"blink_neopixels\0"),
        priority: 2,
        ..Default::default()
    };
    blink_neopixels_thread_cfg.stack_size += 1024;
    blink_neopixels_thread_cfg.set()?;

    // TODO: how do we spawn on a specific core? though the spi driver should be able to use DMA
    let blink_neopixels_handle = thread::spawn(move || {
        blink_neopixels_task(
            &mut neopixel_onboard,
            &mut neopixel_external,
            rng_1,
            &STATE,
            fft_ready_rx,
        )
        .inspect_err(|err| {
            error!("Error in blink_neopixels_task");
            error!("{err:?}");
        })
    });

    // TODO: is this a good idea? i want the light code running ASAP
    yield_now();

    let mut mic_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"mic\0"),
        priority: 2,
        ..Default::default()
    };
    // TODO: this size does not match what i'm actually seeing. i'm confused
    mic_thread_cfg.stack_size += 1024 * 71; // TODO: how much bigger do we actually need?
    mic_thread_cfg.set()?;

    // TODO: make sure this has the highest priority?
    let mic_handle = thread::spawn(move || {
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
    });

    // TODO: is this a good idea? i want the light code running ASAP
    yield_now();

    // TODO: what size? do we need an arc around this? or is a static okay?
    static PONG_RECEIVED: AtomicBool = AtomicBool::new(false);

    // TODO: use the channels that come with idf instead? should they be static? what size should we do? we need to measure the high water mark on these too
    let (message_for_sensors_tx, message_for_sensors_rx) = flume::bounded(4);

    let mut read_from_sensors_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"read_from_sensors\0"),
        priority: 2,
        ..Default::default()
    };
    read_from_sensors_thread_cfg.stack_size += 1024 * 64; // TODO: how much bigger do we actually need?
    read_from_sensors_thread_cfg.set()?;

    let read_from_sensors_handle = thread::spawn(move || {
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
    });

    let send_to_sensors_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"send_to_sensors\0"),
        priority: 2,
        ..Default::default()
    };
    send_to_sensors_thread_cfg.set()?;

    let send_to_sensors_handle = thread::spawn(move || {
        send_to_sensors_task(
            message_for_sensors_rx,
            &PONG_RECEIVED,
            uart_to_sensors.as_mut(),
        )
        .inspect_err(|err| {
            error!("Error in sensor_tx_task: {err}");
        })
    });

    /*
    // TODO: debug-only thread for monitoring ram/cpu/etc?
    let memory_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"memory\0"),
        priority: 1,
        ..Default::default()
    };
    memory_thread_cfg.set()?;

    let _memory_handle = thread::spawn(move || {
        loop {
            // log free memory every 60 seconds. only do this if we are in debug mode
            let free_memory = unsafe { esp_get_free_heap_size() } / 1024;
            let min_free_memory = unsafe { esp_get_minimum_free_heap_size() } / 1024;

            info!("Free memory: {free_memory}KB (min {min_free_memory}KB)");

            // TODO: print stack sizes of all the threads
            // unsafe { heap_caps_dump_all() };

            // uxTaskGetStackHighWaterMark(xTask);

            sleep(Duration::from_secs(1));
        }
    });
     */

    mic_handle.join().unwrap().unwrap();

    // // TODO: how do we do this efficiently?
    // let mut handles = [
    //     Some(("blink", blink_neopixels_handle)),
    //     Some(("read_from_sensors_handle", read_from_sensors_handle)),
    //     Some(("send_to_sensors_handle", send_to_sensors_handle)),
    //     Some(("mic_handle", mic_handle)),
    //     Some(("fft_handle", fft_handle)),
    // ];
    // loop {
    //     for x in handles.iter_mut() {
    //         if x.is_none() || x.as_ref().is_some_and(|(_, x)| !x.is_finished()) {
    //             continue;
    //         }

    //         if let Some((label, handle)) = x.take() {
    //             handle.join().expect("join failed").expect(label);

    //             error!("a thread finished: {}", label);
    //         } else {
    //             unimplemented!();
    //         }
    //     }
    //     sleep(Duration::from_millis(100));
    // }

    // TODO: if we get here, should we force a restart?
    // unsafe { esp_restart() };

    // // this runs forever. it won't ever return. should we have it waiting for errors on a channel?
    // memory_handle.join().unwrap();

    Ok(())
}

// TODO: i'd really love to do this without locking state, but i think we need to.
fn blink_neopixels_task(
    neopixel_onboard: &mut Ws2812Esp32Rmt<'_>,
    neopixel_external: &mut Ws2812Esp32Rmt<'_>,
    mut rng: Biski64Rng,
    state: &'static RwLock<State>,
    fft_ready: flume::Receiver<()>,
) -> eyre::Result<()> {
    info!("Start NeoPixel rainbow!");

    // TOOD: don't start randomly. use the current time (from the gps) so we are in perfect sync with the other art?
    let mut g_hue = rng.next_u32() as u8;

    // TODO: do we want these boxed? they are large. maybe they should be statics instead?
    let mut onboard_data = Box::new([RGB8::default(); NUM_ONBOARD_NEOPIXELS]);
    let mut fibonacci_data = Box::new([RGB8::default(); NUM_FIBONACCI_NEOPIXELS]);

    // TODO: for onboard, we should display a test pattern. 1 red flash, then 2 green flashes, then 3 blue flashes, then 4 white flashes
    // TODO: for fibonacci, we should display a test pattern of 1 red, 1 blank, 2 green, 1 blank, 3 blue, 1 blank, then 4 whites. then whole panel red

    let mut fps = Box::new(FpsTracker::new("pixel"));

    loop {
        debug!("Hue: {g_hue}");

        // TODO: Hsl instead of Hsv?
        let base_hsv = Hsv {
            hue: g_hue,
            sat: 255,
            val: 255,
        };

        // TODO: gamme correct now?
        onboard_data[0] = hsv2rgb(base_hsv);

        // TODO: clone here? is it okay to hold this lock open while we calculate things?
        let state = state.read().map_err(|_| MyError::PoisonLock)?;

        // TODO: have a way to smoothly transition between patterns
        // TODO: new random g_hue whenever the pattern changes?
        match &state.orientation {
            Orientation::FaceDown => {
                flashlight(fibonacci_data.as_mut_slice());
            }
            Orientation::FaceUp => {
                compass(base_hsv, fibonacci_data.as_mut_slice(), &state);
            }
            Orientation::LeftUp | Orientation::RightUp | Orientation::TopUp => {
                // TODO: variable patterns here
                rainbow(base_hsv, fibonacci_data.as_mut_slice());
            }
            Orientation::Unknown => {
                // TODO: cycle between different patterns
                loading(base_hsv, fibonacci_data.as_mut_slice(), &state);
            }
            Orientation::TopDown => clock(base_hsv, fibonacci_data.as_mut_slice()),
        }

        // TODO: does this hold the lock open too long? i think State is a rather large thing to clone?
        drop(state);

        // TODO: reading these from a buffer is probably better than doing any calculations in the iter. that takes more memory, but it works well
        // TODO: check that the gamma correction is what we need for our leds
        // TODO: dithering
        neopixel_onboard.write(brightness(gamma(onboard_data.iter().cloned()), 8))?;

        // TODO: brightness should be from the config
        neopixel_external.write(brightness(gamma(fibonacci_data.iter().cloned()), 16))?;

        // // TODO: run it as fast as the fft updates? or on a timer?
        // // the fft should update consistently and we don't want two frames of the same data, so i think i like this
        // sleep(Duration::from_nanos(
        //     1_000_000_000 / FPS_FIBONACCI_NEOPIXELS,
        // ));
        fft_ready.recv()?;

        g_hue = g_hue.wrapping_add(1);

        fps.tick();

        // log_stack_high_water_mark("blink loop", None);
    }
}

fn mic_task(
    i2s: I2S0,
    bclk: Gpio26,
    ws: Gpio33,
    din: Gpio25,
    fft_ready: &mut flume::Sender<()>,
) -> eyre::Result<()> {
    // sleep(Duration::from_secs(1));
    info!("Start I2S mic!");

    // log_stack_high_water_mark("mic 1", None);

    // TODO: what dma frame counts? what buffer count?
    let channel_cfg = i2s::config::Config::default()
        .frames_per_buffer(I2S_SAMPLE_SIZE as u32)
        .dma_buffer_count(4);

    let clk_cfg = i2s::config::StdClkConfig::new(
        I2S_SAMPLE_RATE_HZ,
        i2s::config::ClockSource::Apll,
        i2s::config::MclkMultiple::M256, // TODO: there is no mclk pin attached though?
    );

    // TODO: really not sure about mono or stereo. it seems like all the default setup uses stereo
    // 24 bit audio is padded to 32 bits. how do they pad the sign though?
    // TODO: do we want to use 8 or 16 or 24 bit audio?
    let slot_cfg = i2s::config::StdSlotConfig::philips_slot_default(
        i2s::config::DataBitWidth::Bits32,
        i2s::config::SlotMode::Mono,
    );

    let gpio_cfg = i2s::config::StdGpioConfig::default();

    // philips doesn't let us set the clocks
    // let i2s_config =
    //     i2s::config::StdConfig::philips(I2S_SAMPLE_RATE_HZ, i2s::config::DataBitWidth::Bits16);

    let i2s_config = i2s::config::StdConfig::new(channel_cfg, clk_cfg, slot_cfg, gpio_cfg);

    // TODO: do we want the mclk pin?
    // TODO: DMA? i think thats handled for us
    let mut i2s_driver = I2sDriver::new_std_rx(i2s, &i2s_config, bclk, din, None::<AnyIOPin>, ws)?;

    i2s_driver.rx_enable()?;
    info!("I2S mic driver enabled");

    // log_stack_high_water_mark("mic 2", None);

    // TODO: this should maybe be a static+Lazy+Mutex instead of a box?
    // TODO: does boxing do what we want?
    // let mut audio_buffer: Box<AudioBuffer<I2S_SAMPLE_SIZE, FFT_INPUTS>> =
    //     Box::new(AudioBuffer::new());

    // info!("Audio buffer created");

    // TODO: the fft is all on the stack. its too big. need to move it to the heap
    // let fft: Box<FFT<FFT_INPUTS, FFT_OUTPUTS>> =
    //     Box::new(FFT::new_with_window::<HanningWindow<FFT_INPUTS>>());

    // let scale_builder = Box::new(ExponentialScaleBuilder::<FFT_OUTPUTS, 32>::new(
    //     20.0,
    //     15_500.0,
    //     I2S_SAMPLE_RATE_HZ as f32,
    // ));
    // info!("scale_builder: {:?}", scale_builder);

    // TODO: what size should this buffer be? i'm really not sure what this data even looks like
    // TODO: do we actually want this in a Box?
    let mut i2s_buffer = Box::new([0u8; I2S_U8_BUFFER_SIZE]);
    info!("i2s_buffer created");

    // TODO: allocate this to somewhere special in ram? there seems to be a lot of choices
    let mut i2s_samples = Box::new(Samples([0.0; I2S_SAMPLE_SIZE]));
    info!("i2s_samples created");

    // theres no need for i2s fps tracking when the pixel has its own tracker
    // let mut fps = Box::new(FpsTracker::new("i2s"));

    // log_stack_high_water_mark("mic 3", None);

    loop {
        // TODO: read with a timeout? read_exact?
        // TODO: this isn't ever returning. what are we doing wrong with the init/config?
        i2s_driver.read_exact(i2s_buffer.as_mut())?;

        // trace!(
        //     "Read i2s: {} {} {} {}",
        //     i2s_buffer[0], i2s_buffer[1], i2s_buffer[2], i2s_buffer[3]
        // );

        // TODO: this should be a helper on Samples
        parse_i2s_24_bit_to_f32_array(&i2s_buffer, &mut i2s_samples.0);

        // TODO: logging the i2s buffer was causing it to crash. i guess writing floats is hard
        // info!("num f32s: {}", samples.0.len());

        // audio_buffer.push_samples(i2s_samples);

        // TODO: actually do things with the buffer. maybe only if the size is %512 or %1024 or %2048

        // // TODO: for some reason rust analyzer is showing 512 here even though it should be more
        // let samples: Samples<FFT_INPUTS> = audio_buffer.samples();

        // let amplitudes = fft.weighted_amplitudes(samples);

        // let loudness = scale_builder.build(amplitudes);
        // // TODO: scaled loudness where a slowly decaying recent min = 0.0 and recent max = 1.0
        // // TODO: shazam
        // // TODO: beat detection

        // info!("loudness: {:?}", loudness);

        // TODO: notify blink_neopixels_task? that way instead of a timer we get the fastest FPS we can push? that might just be wasted resources

        // fps.tick();

        // TODO: is this the best way to notify the other thread to run?
        fft_ready.try_send(()).ok();

        // TODO: this is too verbose. maybe this should take the log level as an arg? or only display once per second? maybe put this into the fps counter?
        // log_stack_high_water_mark("mic loop", None);
    }
}

/// TODO: should state be in a RwLock?
fn read_from_sensors_task<const RAW_BUF_BYTES: usize, const COB_BUF_BYTES: usize>(
    message_to_sensors: flume::Sender<Message>,
    pong_received: &'static AtomicBool,
    state: &'static RwLock<State>,
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
                let mut state = state.write().map_err(|_| MyError::PoisonLock)?;
                state.orientation = orientation;
            }
            Message::Magnetometer(mag) => {
                let mut state = state.write().map_err(|_| MyError::PoisonLock)?;
                state.magnetometer = Some(mag);
            }
            Message::GpsTime(gps_time) => {
                warn!("not sure what to do with gps time. maybe instead connect to the pulse-per-second line? but we don't have many pins available");
            }
            Message::PeerCoordinate(peer_id, coordinate) => {
                let mut state = state.write().map_err(|_| MyError::PoisonLock)?;
                state.peer_coordinate.insert(peer_id, coordinate);
            }
            Message::SelfCoordinate(coordinate) => {
                // TODO: on startup, the key needs to be passed to the sensor board so it can sign radio messages
                let mut state = state.write().map_err(|_| MyError::PoisonLock)?;
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
