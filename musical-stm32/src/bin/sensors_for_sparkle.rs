//! sensor board for the adafruit sparkle
//! this stm32 connects to all the sensors and sends the data across a serial connection to the adafruit sparkle
//! TODO: unwrap less
#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

use ahrs::{Ahrs, Madgwick};
use core::f64::consts::PI;
use embassy_embedded_hal::shared_bus::asynch::spi::SpiDevice;
use embassy_executor::Spawner;
use embassy_stm32::{
    bind_interrupts,
    exti::ExtiInput,
    gpio::{self, Level, Output, Speed},
    mode::Async,
    peripherals::{self},
    spi::{self, Spi},
    time::Hertz,
    usart::{self, Config, Uart},
};
use embassy_sync::{
    blocking_mutex::raw::CriticalSectionRawMutex, channel::Channel, mutex::Mutex, signal::Signal,
};
use embassy_time::{Duration, Timer};
use embedded_alloc::LlffHeap as Heap;
use lsm9ds1::{
    LSM9DS1,
    accel::{self, AccelSettings},
    gyro::{self, GyroSettings},
    interface::SpiInterface,
    mag::{self, MagSettings},
};
use musical_lights_core::{
    errors::{MyError, MyResult},
    logging::{info, warn},
    message::{MESSAGE_BAUD_RATE, Message},
    orientation::Orientation,
};
use musical_stm32::sparkle_uart::{UartFromSparkle, UartToSparkle};
use nalgebra::Vector3;
use static_cell::StaticCell;
use {defmt_rtt as _, panic_probe as _};

#[global_allocator]
static HEAP: Heap = Heap::empty();

/// TODO: is this size right? how many messages do we expect to send at once?
const MESSAGE_CHANNEL_SIZE: usize = 8;

type MyRawMutex = CriticalSectionRawMutex;

pub type MySpi = Spi<'static, Async>;
pub type MySpiBus = Mutex<MyRawMutex, MySpi>;
pub type MySpiDevice<CS> = SpiDevice<'static, MyRawMutex, MySpi, CS>;

pub type AccelDevice = MySpiDevice<Output<'static>>;
pub type MagnetDevice = MySpiDevice<Output<'static>>;
pub type RadioDevice = MySpiDevice<Output<'static>>;

pub type MyChannel<T, const S: usize> = Channel<MyRawMutex, T, S>;
pub type MySender<T, const S: usize> = embassy_sync::channel::Sender<'static, MyRawMutex, T, S>;
pub type MyReceiver<T, const S: usize> = embassy_sync::channel::Receiver<'static, MyRawMutex, T, S>;

pub type MyMessageChannel = MyChannel<Message, MESSAGE_CHANNEL_SIZE>;
pub type MyMessageSender = MySender<Message, MESSAGE_CHANNEL_SIZE>;
pub type MyMessageReceiver = MyReceiver<Message, MESSAGE_CHANNEL_SIZE>;

pub type MyLSM9DS1 = LSM9DS1<SpiInterface<AccelDevice, MagnetDevice>>;

bind_interrupts!(struct Irqs {
    USART1 => usart::InterruptHandler<peripherals::USART1>;
    USART2 => usart::InterruptHandler<peripherals::USART2>;
    // TODO: bind for the accelerometer/magnetometer. it has data ready and programmable ones
    // TODO: bind for the SPI?
});

#[embassy_executor::task]
async fn blink_task(mut led: Output<'static>) {
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
async fn read_from_sparkle_task(
    mut uart: UartFromSparkle<'static, 256, 256>,
    send_to_sparkle: MyMessageSender,
    handleshake_complete: &'static Signal<CriticalSectionRawMutex, bool>,
) {
    uart.read_loop(|x| async {
        match x {
            Message::Ping => {
                send_to_sparkle.send(Message::Pong).await;
                // TODO: ack/syn/synack instead of ping pong?
                handleshake_complete.signal(true);
            }
            msg => {
                // TODO: what should we do with the different message types here?
                warn!("dropping message: {:?}", msg);
            }
        }
    })
    .await
    .expect("uart read loop should never exit");
}

/// read from a channel and send to the sparkle via UART
#[embassy_executor::task]
async fn send_to_sparkle_task(channel: MyMessageReceiver, mut uart: UartToSparkle<'static, 256>) {
    loop {
        let message = channel.receive().await;
        info!("sending message to sparkle: {:?}", message);

        uart.write(&message)
            .await
            .expect("failed to write to sparkle uart");
    }
}

#[embassy_executor::task]
async fn read_gps_task(gps: (), channel: MyMessageSender) {
    todo!();
}

#[embassy_executor::task]
async fn read_lsm9ds1_task(
    // TODO: add a `split` function to the lsm9ds1 so that we can have two different tasks using it
    mut lsm9ds1: LSM9DS1<SpiInterface<AccelDevice, MagnetDevice>>,
    // TODO: theres two interrupts here, possible too
    mut accel_gyro_data_ready: ExtiInput<'static>,
    mut magnet_interrupt: ExtiInput<'static>,
    channel: MyMessageSender,
) {
    // TODO: i can't put an except on these. its saying it can't convert the errors
    lsm9ds1.begin_accel().await.unwrap();
    lsm9ds1.begin_gyro().await.unwrap();
    lsm9ds1.begin_mag().await.unwrap();

    // TODO: configure interrupt pins. i'm not sure what the defaul settings re
    // TODO: there are 2 accel gyro interrupts too. i'm not sure what the best design is. just get something basic working and you can make it better letter

    // the accelerometer and gyro are ready
    accel_gyro_data_ready.wait_for_high().await;
    // the magnetometer is ready
    magnet_interrupt.wait_for_high().await;

    // TODO: check the non-volatile storage to see if this device has been calibrated before, do some calibration setup here

    // this should be the lowest of the update rates on the lsm. how can we check that?

    // TODO: should this just be the same as the framerate? maybe it should be a multiple of the framerate?
    const UPDATE_HZ: u64 = 80;

    // TODO: what should beta be? 0.1 was the value in the docs
    let mut ahrs: Madgwick<f64> = Madgwick::new(1.0 / UPDATE_HZ as f64, 0.1);

    let mut last_orientation = Orientation::Unknown;

    // TODO: how should this loop work? we need to select on multiple interrupts
    loop {
        // 40Hz updates. we should maybe do this dynamically based on how long loaded data actually took?
        Timer::after(Duration::from_micros(1_000_000 / UPDATE_HZ)).await;

        let new_orientation = read_accel_gyro_mag(&mut lsm9ds1, &mut ahrs)
            .await
            .expect("using lsm9ds1");

        if new_orientation == last_orientation {
            continue;
        }

        channel.send(Message::Orientation(new_orientation)).await;

        last_orientation = new_orientation;
    }
}

/// TODO: move this to another module
async fn read_accel_gyro_mag(
    lsm9ds1: &mut MyLSM9DS1,
    ahrs: &mut Madgwick<f64>,
) -> MyResult<Orientation> {
    // i think that reading the data clears the ready pin
    // TODO: read raw and have the ahrs use i16? i don't think we want that
    let (mag_x, mag_y, mag_z) = lsm9ds1.read_mag().await.unwrap();
    let (accel_x, accel_y, accel_z) = lsm9ds1.read_accel().await.unwrap();
    let (gyro_x, gyro_y, gyro_z) = lsm9ds1.read_gyro().await.unwrap();

    // TODO: what should we do now? what do these numbers actually mean?
    // TODO: apply calibrations!

    // Obtain sensor values from a source
    let gyroscope = Vector3::new(gyro_x as f64, gyro_y as f64, gyro_z as f64);
    let accelerometer = Vector3::new(accel_x as f64, accel_y as f64, accel_z as f64);
    let magnetometer = Vector3::new(mag_x as f64, mag_y as f64, mag_z as f64);

    // Run inputs through AHRS filter (gyroscope must be radians/s)
    // an AHRS is probably way overkill for what I'm building right now
    let quat = ahrs
        .update(&(gyroscope * (PI / 180.0)), &accelerometer, &magnetometer)
        .map_err(MyError::Ahrs)?;

    Ok(Orientation::from_quat(quat))
}

#[embassy_executor::task]
async fn radio_task(radio: (), to_sparkle: MyMessageSender, to_radio: MyMessageReceiver) {
    todo!();
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    // Initialize the allocator BEFORE you use it
    // TODO: do we actually need an allocator? anyhow requires one. i think we should avoid using an allocator if possible
    {
        use core::mem::MaybeUninit;
        const HEAP_SIZE: usize = 1024;
        static mut HEAP_MEM: [MaybeUninit<u8>; HEAP_SIZE] = [MaybeUninit::uninit(); HEAP_SIZE];
        unsafe { HEAP.init(&raw mut HEAP_MEM as usize, HEAP_SIZE) }
    }

    let peripheral_config = Default::default();

    // // TODO: i think we might want non-default clocks: https://github.com/embassy-rs/embassy/blob/main/examples/stm32f334/src/bin/adc.rs
    // let mut config = Config::default();
    // config.rcc.sysclk = Some(mhz(64));
    // config.rcc.hclk = Some(mhz(64));
    // config.rcc.pclk1 = Some(mhz(32));
    // config.rcc.pclk2 = Some(mhz(64));
    // config.rcc.adc = Some(AdcClockSource::Pll(Adcpres::DIV1));

    let p = embassy_stm32::init(peripheral_config);

    info!("Hello World!");

    // set up devices
    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low);

    let mut uart_sparkle_config = Config::default();
    uart_sparkle_config.baudrate = MESSAGE_BAUD_RATE; // this baud rate needs to match the sparkle's baud rate

    // TODO: double check the pin diagram!
    let uart_sparkle = Uart::new(
        p.USART1,
        p.PA10,
        p.PB6,
        Irqs,
        p.DMA2_CH7,
        p.DMA2_CH5,
        uart_sparkle_config,
    )
    .expect("failed to create UART1 for sparkle");

    let (uart_sparkle_tx, uart_sparkle_rx) = uart_sparkle.split();

    // TODO: What should the buffer sizes be?!
    let uart_sparkle_tx = UartToSparkle::<256>::new(uart_sparkle_tx);
    let uart_sparkle_rx = UartFromSparkle::<256, 256>::new(uart_sparkle_rx);

    let mut uart_gps_config = Config::default();
    uart_gps_config.baudrate = 9600; // GPS baud rate, this must match the GPS module's baud rate

    // TODO: double check the pin diagram!
    let uart_gps = Uart::new(
        p.USART2,
        p.PA3,
        p.PA2,
        Irqs,
        p.DMA1_CH6,
        p.DMA1_CH7,
        uart_gps_config,
    )
    .expect("failed to create UART2 for gps");

    // TODO: do we actually want to split this? we need to fork the adafruit_gps library to work with no_std and embedded-hal-async
    // let (uart_gps_tx, uart_gps_rx) = uart_gps.split();

    let mut spi_config = spi::Config::default();
    // TODO: what frequency?
    spi_config.frequency = Hertz(1_000_000);

    let spi: MySpi = Spi::new(
        p.SPI1, p.PA5, p.PA7, p.PA6, p.DMA2_CH2, p.DMA2_CH0, spi_config,
    );

    static SPI_BUS: StaticCell<MySpiBus> = StaticCell::new();
    let spi_bus = SPI_BUS.init(Mutex::new(spi));

    // TODO: default of high or low? what speed?
    let spi_ag_cs = Output::new(p.PA8, Level::High, Speed::VeryHigh);
    let spi_mag_cs = Output::new(p.PA9, Level::High, Speed::VeryHigh);
    let spi_radio_cs = Output::new(p.PA14, Level::High, Speed::VeryHigh);

    // TODO: any more chip selects on the spi?
    // TODO: not sure about this pull mode. or these pins. but i think this is close
    // TODO: accel/gyro has 2 interrupts. maybe use those
    let spi_accel_gyro_drdy = ExtiInput::new(p.PA11, p.EXTI11, gpio::Pull::Down);
    let spi_magnetometer_int = ExtiInput::new(p.PA12, p.EXTI12, gpio::Pull::Down);

    let spi_accel_gyro: AccelDevice = SpiDevice::new(spi_bus, spi_ag_cs);
    let spi_magnetometer: MagnetDevice = SpiDevice::new(spi_bus, spi_mag_cs);
    let spi_radio: RadioDevice = SpiDevice::new(spi_bus, spi_radio_cs);

    let lsm9sd1_spi_interface =
        lsm9ds1::interface::SpiInterface::init(spi_accel_gyro, spi_magnetometer);
    // TODO: these all have slightly different sample rates. i don't love that. just be higher than our framerate?
    // TODO: we don't actually care about the mag settings unless we are displaying the compass
    let lsm9ds1 = lsm9ds1::LSM9DS1Init {
        accel: AccelSettings {
            sample_rate: accel::ODR::_119Hz,
            scale: accel::Scale::_4G,
            // bandwidth: ???,
            // TODO: what other settings?
            ..Default::default()
        },
        gyro: GyroSettings {
            sample_rate: gyro::ODR::_119Hz,
            scale: gyro::Scale::_245DPS,
            // bandwidth: ???
            // TODO: what other settings?
            ..Default::default()
        },
        mag: MagSettings {
            // TODO:
            sample_rate: mag::ODR::_80Hz,
            i2c_mode: mag::I2cMode::Disabled,
            spi_mode: mag::SpiMode::RW,
            // TODO: what other settings?
            ..Default::default()
        },
    }
    .with_interface(lsm9sd1_spi_interface);

    // TODO: device for the radio. it uses SPI

    // TODO: any other devices to set up?
    // TODO: capacitive touch for controlling the brightness and other things?

    // TODO: wait here for a ping from the sparkle before doing anything? or should we just start sending on a schedule?

    // set up channels so that the tasks can communicate
    // TODO: these should really be mpsc channels
    static TO_SPARKLE_CHANNEL: MyMessageChannel = Channel::new();
    // TODO: these should really be mpsc channels
    static TO_RADIO_CHANNEL: MyMessageChannel = Channel::new();

    static SPARKLE_READY: Signal<CriticalSectionRawMutex, bool> = Signal::new();

    // spawn some of the tasks. not the ones that talk to the sparkle yet
    spawner.must_spawn(blink_task(onboard_led));
    spawner.must_spawn(send_to_sparkle_task(
        TO_SPARKLE_CHANNEL.receiver(),
        uart_sparkle_tx,
    ));
    spawner.must_spawn(read_from_sparkle_task(
        uart_sparkle_rx,
        TO_SPARKLE_CHANNEL.sender(),
        &SPARKLE_READY,
    ));

    SPARKLE_READY.wait().await;

    // spawn the rest of the tasks. these tasks might send things to the sparkle board
    spawner.must_spawn(read_gps_task((), TO_SPARKLE_CHANNEL.sender()));
    spawner.must_spawn(read_lsm9ds1_task(
        lsm9ds1,
        spi_accel_gyro_drdy,
        spi_magnetometer_int,
        TO_SPARKLE_CHANNEL.sender(),
    ));
    spawner.must_spawn(radio_task(
        (),
        TO_SPARKLE_CHANNEL.sender(),
        TO_RADIO_CHANNEL.receiver(),
    ));

    info!("all tasks started");
}
