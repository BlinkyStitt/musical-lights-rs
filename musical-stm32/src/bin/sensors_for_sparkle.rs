//! sensor board for the adafruit sparkle
//! this stm32 connects to all the sensors and sends the data across a serial connection to the adafruit sparkle
#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

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
    usart::{self, Config, Uart, UartTx},
};
use embassy_sync::{blocking_mutex::raw::CriticalSectionRawMutex, channel::Channel, mutex::Mutex};
use embassy_time::Timer;
use embedded_io_async::Write;
use lsm9ds1::{LSM9DS1, interface::SpiInterface};
use musical_lights_core::message::{MESSAGE_BAUD_RATE, Message};
use musical_lights_core::{logging::info, message::serialize_with_crc_and_cobs};
use static_cell::StaticCell;
use {defmt_rtt as _, panic_probe as _};

/// TODO: is this size right? how many messages do we expect to send at once?
const MESSAGE_CHANNEL_SIZE: usize = 8;

type MyRawMutex = CriticalSectionRawMutex;

pub type MySpi = Spi<'static, Async>;
pub type MySpiBus = Mutex<MyRawMutex, MySpi>;
pub type MySpiDevice<CS> = SpiDevice<'static, MyRawMutex, MySpi, CS>;

pub type AccelDevice = MySpiDevice<Output<'static>>;
pub type MagnetDevice = MySpiDevice<Output<'static>>;

pub type MyChannel<T, const S: usize> = Channel<MyRawMutex, T, S>;
pub type MySender<T, const S: usize> = embassy_sync::channel::Sender<'static, MyRawMutex, T, S>;
pub type MyReceiver<T, const S: usize> = embassy_sync::channel::Receiver<'static, MyRawMutex, T, S>;

pub type MyMessageChannel = MyChannel<Message, MESSAGE_CHANNEL_SIZE>;
pub type MyMessageSender = MySender<Message, MESSAGE_CHANNEL_SIZE>;
pub type MyMessageReceiver = MyReceiver<Message, MESSAGE_CHANNEL_SIZE>;

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

/// read from a channel and send to the sparkle via UART
#[embassy_executor::task]
async fn send_to_sparkle_task(channel: MyMessageReceiver, mut uart_tx: UartTx<'static, Async>) {
    // TODO: how long should these buffers be?
    let mut crc_buffer = [0u8; 256];
    let mut output_buffer = [0u8; 256];

    loop {
        let message = channel.receive().await;
        info!("sending message to sparkle: {:?}", message);

        // TODO: save the mssage to some local state? that way we can resend someone's locations?

        let encoded_len =
            serialize_with_crc_and_cobs(&message, &mut crc_buffer, &mut output_buffer)
                .expect("failed to serialize message for sparkle");

        // this double buffering seems wrong, but the docs seem to say that the regular UartTx
        uart_tx
            .write_all(&output_buffer[..encoded_len])
            .await
            .expect("failed to write to sparkle uart");
    }
}

#[embassy_executor::task]
async fn read_gps_task(gps: (), mut channel: MyMessageSender) {
    todo!();
}

#[embassy_executor::task]
async fn read_lsm9ds1_task(
    lsm9ds1: LSM9DS1<SpiInterface<AccelDevice, MagnetDevice>>,
    // TODO: theres two interrupts here, possible too
    mut accel_gyro_data_ready: ExtiInput<'static>,
    mut magnet_interrupt: ExtiInput<'static>,
    mut channel: MyMessageSender,
) {
    loop {
        accel_gyro_data_ready.wait_for_rising_edge().await;
        todo!();
    }
}

#[embassy_executor::task]
async fn read_radio_task(radio: (), mut channel: MyMessageSender) {
    todo!();
}

/// this should maybe have a different channel type that has types specifically for the radio messages
#[embassy_executor::task]
async fn send_radio_task(radio: (), mut channel: MyMessageReceiver) {
    todo!();
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

    // set up devices
    let onboard_led = Output::new(p.PC13, Level::High, Speed::Low);

    let mut uart_sparkle_config = Config::default();
    uart_sparkle_config.baudrate = MESSAGE_BAUD_RATE; // this baud rate needs to match the sparkle's baud rate

    // TODO: check the pin diagram!
    let uart_sparkle = Uart::new(
        p.USART1,
        p.PA10,
        p.PB6,
        Irqs,
        p.DMA2_CH7, // TODO: what channel?
        p.DMA2_CH5, // TODO: what channel?
        uart_sparkle_config,
    )
    .expect("failed to create UART1 for sparkle");

    let (uart_sparkle_tx, uart_sparkle_rx) = uart_sparkle.split();

    let mut uart_gps_config = Config::default();
    uart_gps_config.baudrate = 9600; // GPS baud rate, this must match the GPS module's baud rate

    // TODO: check the pin diagram!
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

    // TODO: do we actually want to split this? i think it will probably be easier to sent then wait on the receiver, but maybe not
    let (uart_gps_tx, uart_gps_rx) = uart_gps.split();

    let mut spi_config = spi::Config::default();
    // TODO: what frequency?
    spi_config.frequency = Hertz(1_000_000);

    let spi: MySpi = Spi::new(
        p.SPI1, p.PA5, p.PA7, p.PA6, p.DMA2_CH2, p.DMA2_CH0, spi_config,
    );

    static SPI_BUS: StaticCell<MySpiBus> = StaticCell::new();
    let spi_bus = SPI_BUS.init(Mutex::new(spi));

    let spi_ag_cs = Output::new(p.PA8, Level::High, Speed::Low);
    let spi_m_cs = Output::new(p.PA9, Level::High, Speed::Low);

    let spi_accel_gyro: AccelDevice = SpiDevice::new(spi_bus, spi_ag_cs);
    let spi_magnetometer: MagnetDevice = SpiDevice::new(spi_bus, spi_m_cs);

    let spi_interface = lsm9ds1::interface::SpiInterface::init(spi_accel_gyro, spi_magnetometer);
    // TODO: we probably some non-default settings. maybe some interrupt configurations
    let lsm9ds1 = lsm9ds1::LSM9DS1Init {
        ..Default::default()
    }
    .with_interface(spi_interface);

    // TODO: not sure about this pull mode. or these pins. but i think this is close
    // TODO: accel/gyro has 2 interrupts. maybe use those
    let spi_accel_gyro_drdy = ExtiInput::new(p.PA11, p.EXTI11, gpio::Pull::Down);
    let spi_magnetometer_int = ExtiInput::new(p.PA12, p.EXTI12, gpio::Pull::Down);

    // TODO: capacitive touch for controlling the brightness and other things?

    // TODO: wait here for a ping from the sparkle before doing anything? or should we just start sending on a schedule?

    // set up channels so that the tasks can communicate

    static TO_SPARKLE_CHANNEL: MyMessageChannel = Channel::new();
    static TO_RADIO_CHANNEL: MyMessageChannel = Channel::new();

    // spawn the tasks
    spawner.must_spawn(blink_task(onboard_led));
    spawner.must_spawn(send_to_sparkle_task(
        TO_SPARKLE_CHANNEL.receiver(),
        uart_sparkle_tx,
    ));

    spawner.must_spawn(read_gps_task((), TO_SPARKLE_CHANNEL.sender()));
    spawner.must_spawn(read_lsm9ds1_task(
        lsm9ds1,
        spi_accel_gyro_drdy,
        spi_magnetometer_int,
        TO_SPARKLE_CHANNEL.sender(),
    ));
    spawner.must_spawn(read_radio_task((), TO_SPARKLE_CHANNEL.sender()));
    spawner.must_spawn(send_radio_task((), TO_RADIO_CHANNEL.receiver()));

    // TODO: spawn the tasks for the sensors

    info!("all tasks started");
}
