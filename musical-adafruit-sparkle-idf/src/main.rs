//! TODO: totally unsure of prioritites. i should just start with everything on the same priority probably
#![feature(type_alias_impl_trait)]
#![feature(slice_as_array)]

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
use esp_idf_sys::{
    bootloader_random_disable, bootloader_random_enable, esp_get_free_heap_size, esp_random,
    uxTaskGetStackHighWaterMark2,
};
use flume::Receiver;
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
use rand::RngCore;
use smart_leds::{
    brightness, gamma,
    hsv::{hsv2rgb, Hsv},
    RGB8,
};
use smart_leds_trait::SmartLedsWrite;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, sleep},
};
use std::{sync::Mutex, time::Duration};
use ws2812_esp32_rmt_driver::Ws2812Esp32Rmt;

use crate::{
    light_patterns::{clock, compass, flashlight, rainbow},
    sensor_uart::{UartFromSensors, UartToSensors},
};

const NUM_ONBOARD_NEOPIXELS: usize = 1;
const NUM_FIBONACCI_NEOPIXELS: usize = 256;
/// TODO: this is probably too high once we have a bunch of other things going on. but lets try out two cores!
/// TODO: should this match our slowest sensor?
const FPS_FIBONACCI_NEOPIXELS: u64 = 100;
const I2S_SAMPLE_RATE_HZ: u32 = 48_000;

/// TODO: what size FFT? make sure the dma buffers from the i2s fit
const FFT_INPUTS: usize = 4096;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

/// TODO: really not sure about this. i think it comes from dma sizes that i don't see how to control
const I2S_U8_BUFFER_SIZE: usize = I2S_SAMPLE_SIZE * size_of::<i32>();
/// TODO: how do we make sure this fits cleanly inside the fft inputs? and also that its not so big that it slows down
const I2S_SAMPLE_SIZE: usize = 256;

/// TODO: add a lot more to this
/// TODO: max capacity on the HashMap?
/// TODO: include self in the main peer_coordinate map?
#[derive(Clone, Default, Debug)]
struct State {
    orientation: Orientation,
    magnetometer: Magnetometer,
    self_coordinate: Coordinate,
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
    let uart_from_sensors: UartFromSensors<'_, 256, 256> = UartFromSensors::new(uart_to_sensors_rx);
    let uart_to_sensors: UartToSensors<'_, 256> = UartToSensors::new(uart_to_sensors_tx);

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

    // TODO: static? arc? something else?
    let state = Arc::new(Mutex::new(State::default()));

    let blink_neopixels_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"blink_neopixels\0"),
        priority: 2,
        ..Default::default()
    };
    blink_neopixels_thread_cfg.set()?;

    // TODO: how do we spawn on a specific core? though the spi driver should be able to use DMA
    let blink_neopixels_state = state.clone();
    let blink_neopixels_handle = thread::spawn(move || {
        blink_neopixels_task(
            &mut neopixel_onboard,
            &mut neopixel_external,
            rng_1,
            blink_neopixels_state,
        )
        .inspect_err(|err| {
            error!("Error in blink_neopixels_task: {err}");
        })
    });

    // TODO: what size?
    let (audio_sample_tx, audio_sample_rx) = flume::bounded::<Samples<I2S_SAMPLE_SIZE>>(4);

    // TODO: what size?
    static PONG_RECEIVED: AtomicBool = AtomicBool::new(false);

    let (message_for_sensors_tx, message_for_sensors_rx) = flume::bounded(4);

    let read_from_sensors_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"read_from_sensors\0"),
        priority: 2,
        ..Default::default()
    };
    read_from_sensors_thread_cfg.set()?;

    let read_from_sensors_handle = thread::spawn(move || {
        read_from_sensors_task(
            message_for_sensors_tx,
            &PONG_RECEIVED,
            state,
            uart_from_sensors,
        )
        .inspect_err(|err| {
            error!("Error in sensor_rx_task: {err}");
        })
    });

    let send_to_sensors_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"send_to_sensors\0"),
        priority: 2,
        ..Default::default()
    };
    send_to_sensors_thread_cfg.set()?;

    let send_to_sensors_handle = thread::spawn(move || {
        send_to_sensors_task(message_for_sensors_rx, &PONG_RECEIVED, uart_to_sensors).inspect_err(
            |err| {
                error!("Error in sensor_tx_task: {err}");
            },
        )
    });

    let fft_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"fft\0"),
        priority: 2,
        ..Default::default()
    };
    fft_thread_cfg.set()?;

    let fft_handle = thread::spawn(move || {
        fft_task(audio_sample_rx).inspect_err(|err| {
            error!("Error in fft_task: {err}");
        })
    });

    let mic_thread_cfg = ThreadSpawnConfiguration {
        name: Some(b"mic\0"),
        priority: 2,
        ..Default::default()
    };
    mic_thread_cfg.set()?;

    // TODO: make sure this has the highest priority?
    let mic_handle = thread::spawn(move || {
        mic_task(
            peripherals.i2s0,
            pins.gpio26,
            pins.gpio33,
            pins.gpio25,
            audio_sample_tx,
        )
        .inspect_err(|err| {
            error!("Error in mic task: {err}");
        })
    });

    // TODO: debug-only thread for monitoring ram/cpu/etc?

    // let memory_thread_cfg = ThreadSpawnConfiguration {
    //     stack_size
    // }

    let memory_thread_cfg = ThreadSpawnConfiguration {
        name: Some("memory".as_bytes()),
        priority: 1,
        ..Default::default()
    };
    memory_thread_cfg.set()?;

    let _memory_handle = thread::spawn(move || {
        loop {
            // log free memory every 60 seconds. only do this if we are in debug mode
            let free_memory = unsafe { esp_get_free_heap_size() } / 1024;
            info!("Free memory: {free_memory}KB");

            sleep(Duration::from_secs(1));
        }
    });

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

fn blink_neopixels_task(
    neopixel_onboard: &mut Ws2812Esp32Rmt<'_>,
    neopixel_external: &mut Ws2812Esp32Rmt<'_>,
    mut rng: Biski64Rng,
    state: Arc<Mutex<State>>,
) -> eyre::Result<()> {
    info!("Start NeoPixel rainbow!");

    // TOOD: don't start randomly. use the current time (from the gps) so we are in perfect sync with the other art?
    let mut g_hue = rng.next_u32() as u8;

    // TODO: do we want these boxed? they are large
    let mut onboard_data = Box::new([RGB8::default(); NUM_ONBOARD_NEOPIXELS]);
    let mut fibonacci_data = Box::new([RGB8::default(); NUM_FIBONACCI_NEOPIXELS]);

    // TODO: for onboard, we should display a test pattern. 1 red flash, then 2 green flashes, then 3 blue flashes, then 4 white flashes
    // TODO: for fibonacci, we should display a test pattern of 1 red, 1 blank, 2 green, 1 blank, 3 blue, 1 blank, then 4 whites. then whole panel red

    let mut fps = FpsTracker::new("pixel");

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

        // TODO: don't clone?
        let state = state.lock().map_err(|_| MyError::PoisonLock)?.clone();

        // TODO: have a way to smoothly transition between patterns
        // TODO: new random g_hue whenever the pattern changes?
        match state.orientation {
            Orientation::FaceDown => {
                flashlight(fibonacci_data.as_mut_slice());
            }
            Orientation::FaceUp => {
                compass(base_hsv, fibonacci_data.as_mut_slice());
            }
            Orientation::LeftUp
            | Orientation::RightUp
            | Orientation::TopUp
            | Orientation::Unknown => {
                // TODO: cycle between different patterns
                rainbow(base_hsv, fibonacci_data.as_mut_slice());
            }
            Orientation::TopDown => clock(base_hsv, fibonacci_data.as_mut_slice()),
        }

        // TODO: reading these from a buffer is probably better than doing any calculations in the iter. that takes more memory, but it works well
        // TODO: check that the gamma correction is what we need for our leds
        // TODO: dithering
        neopixel_onboard.write(brightness(gamma(onboard_data.iter().cloned()), 8))?;

        // TODO: brightness should be from the config
        neopixel_external.write(brightness(gamma(fibonacci_data.iter().cloned()), 16))?;

        sleep(Duration::from_nanos(
            1_000_000_000 / FPS_FIBONACCI_NEOPIXELS,
        ));

        g_hue = g_hue.wrapping_add(1);

        fps.tick();
    }
}

/// TODO: this size is wrong. we don't get 4096 at once. we get some weird amount like 4092 u8s (1023 i32s)
fn fft_task(audio_sample_rx: Receiver<Samples<I2S_SAMPLE_SIZE>>) -> eyre::Result<()> {
    return Ok(());

    // create windows and weights and everything before starting any tasks
    let mut audio_buffer: AudioBuffer<I2S_SAMPLE_SIZE, FFT_INPUTS> = AudioBuffer::new();

    // TODO: i need custom weighting. the microphone dynamic gain might not work well with this
    // TODO: i think the microphone might already have a weighting!
    // let equal_loudness_weighting = AWeighting::new(SAMPLE_RATE);

    let fft: FFT<FFT_INPUTS, FFT_OUTPUTS> = FFT::new_with_window::<HanningWindow<FFT_INPUTS>>();

    // TODO: bark scale? exponential scale? something else?
    // i wanted to do bark scale, but it has 24 outputs and 256 isn't divisibly by 24
    // let scale_builder = BarkScaleBuilder::<FFT_OUTPUTS>::new(I2S_SAMPLE_RATE_HZ as f32);
    let scale_builder =
        ExponentialScaleBuilder::<FFT_OUTPUTS, 32>::new(20.0, 15_500.0, I2S_SAMPLE_RATE_HZ as f32);

    loop {
        let samples = audio_sample_rx.recv()?;

        info!("received samples");

        audio_buffer.push_samples(samples);

        // TODO: for some reason rust analyzer is showing 512 here even though it should be more
        let samples: Samples<FFT_INPUTS> = audio_buffer.samples();

        let amplitudes = fft.weighted_amplitudes(samples);

        let loudness = scale_builder.build(amplitudes);
        // TODO: scaled loudness where a slowly decaying recent min = 0.0 and recent max = 1.0
        // TODO: shazam
        // TODO: beat detection

        info!("loudness: {:?}", loudness);
    }
}

fn mic_task(
    i2s: I2S0, /*dma: I2s0DmaChannel, */
    bclk: Gpio26,
    ws: Gpio33,
    din: Gpio25,
    audio_sample_tx: flume::Sender<Samples<I2S_SAMPLE_SIZE>>,
) -> eyre::Result<()> {
    info!("Start I2S mic!");

    // TODO: what dma frame counts? what buffer count?
    let channel_cfg = i2s::config::Config::default()
        .frames_per_buffer(512)
        .dma_buffer_count(4);

    let clk_cfg = i2s::config::StdClkConfig::new(
        I2S_SAMPLE_RATE_HZ,
        i2s::config::ClockSource::Apll,
        i2s::config::MclkMultiple::M256, // TODO: there is no mclk pin attached though
    );

    // TODO: really not sure about mono or stereo. it seems like all the default setup uses stereo
    // 24 bit audio is padded to 32 bits. how do they pad the sign though?
    // TODO: do we want to use 8 or 16 or 24 bit audio?
    let slot_cfg = i2s::config::StdSlotConfig::philips_slot_default(
        i2s::config::DataBitWidth::Bits32,
        i2s::config::SlotMode::Mono,
    );

    let gpio_cfg = i2s::config::StdGpioConfig::default();

    // let i2s_config =
    //     i2s::config::StdConfig::philips(I2S_SAMPLE_RATE_HZ, i2s::config::DataBitWidth::Bits16);

    // TODO: i think we need a different config like this:
    let i2s_config = i2s::config::StdConfig::new(channel_cfg, clk_cfg, slot_cfg, gpio_cfg);

    // TODO: do we want the mclk pin?
    // TODO: DMA? i think thats handled for us
    let mut i2s_driver = I2sDriver::new_std_rx(i2s, &i2s_config, bclk, din, None::<AnyIOPin>, ws)?;

    i2s_driver.rx_enable()?;

    info!("I2S mic driver created");

    // TODO: what size should this buffer be? i'm really not sure what this data even looks like
    let mut i2s_buffer = Box::new([0u8; I2S_U8_BUFFER_SIZE]);
    loop {
        // TODO: read with a timeout? read_exact?
        // TODO: this isn't ever returning. what are we doing wrong with the init/config?
        i2s_driver.read_exact(i2s_buffer.as_mut_slice())?;

        info!(
            "Read i2s: {} {} {} {}",
            i2s_buffer[0], i2s_buffer[1], i2s_buffer[2], i2s_buffer[3]
        );

        // TODO: without the box, this is causing a stack overflow
        // // TODO: is this always going to be the same size? should we use our allocator here and allow different sized vecs?
        // TODO: uninit?
        // let mut samples: Box<[f32; I2S_SAMPLE_SIZE]> = Box::new([0.0; I2S_SAMPLE_SIZE]);
        let mut samples: [f32; I2S_SAMPLE_SIZE] = [0.0; I2S_SAMPLE_SIZE];

        // parse_i2s_24_bit_to_f32_array(
        //     i2s_buffer.as_slice(),
        //     samples.as_mut_array::<I2S_SAMPLE_SIZE>().unwrap(),
        // );

        // info!(
        //     "Read bytes from I2S mic: {} ... {}",
        //     samples[0],
        //     samples[I2S_SAMPLE_SIZE - 1],
        // );

        // audio_sample_tx.send(Samples(samples))?;
    }
}

fn read_from_sensors_task<const RAW_BUF_BYTES: usize, const COB_BUF_BYTES: usize>(
    message_to_sensors: flume::Sender<Message>,
    pong_received: &'static AtomicBool,
    state: Arc<Mutex<State>>,
    mut uart_from_sensors: UartFromSensors<'static, RAW_BUF_BYTES, COB_BUF_BYTES>,
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
                pong_received.store(true, Ordering::Relaxed);
            }
            Message::Orientation(orientation, mag) => {
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.orientation = orientation;
                state.magnetometer = mag;
            }
            Message::GpsTime(gps_time) => {
                warn!("not sure what to do with gps time. maybe instead connect to the pulse-per-second line? but we don't have many pins available");
            }
            Message::PeerCoordinate(peer_id, coordinate) => {
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.peer_coordinate.insert(peer_id, coordinate);
            }
            Message::SelfCoordinate(coordinate) => {
                // TODO: on startup, the key needs to be passed to the sensor board so it can sign radio messages
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.self_coordinate = coordinate;
            }
        }

        // TODO: should we send state into a watch channel? or is a mutex enough? arcswap maybe?
        Ok::<_, MyError>(())
    };

    // TODO: WE NEED A MOCK FUNCTION HERE!
    process_message(Message::Pong).unwrap();

    // TODO: no idea what the timeout should be
    // TODO: i think maybe we should use the async reader? we don't want a timeout
    // uart_from_sensors.read_loop(process_message, 10)?;

    // once the read loop exits, what should we do? it exits when it isn't connected

    Ok(())
}

fn send_to_sensors_task<const N: usize>(
    message_to_sensors: flume::Receiver<Message>,
    pong_received: &'static AtomicBool,
    mut uart_to_sensors: UartToSensors<'static, N>,
) -> eyre::Result<()> {
    return Ok(());

    // send a ping on an interval until we get a pong. then continue
    while !pong_received.load(Ordering::Relaxed) {
        info!("sending ping");
        uart_to_sensors.write(&Message::Ping)?;
        sleep(Duration::from_millis(100));
    }

    // listen on a channel to see if we need to send anything more. i don't think we will
    loop {
        let message = message_to_sensors.recv()?;

        info!("writing to uart");
        uart_to_sensors.write(&message)?;
    }
}
