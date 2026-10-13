//! Independent sensor/radio acquisition for the Sparkle display, using Embassy.
#![no_std]
#![no_main]
use embassy_embedded_hal::shared_bus::asynch::spi::SpiDevice;
use embassy_executor::Spawner;
use embassy_stm32::{
    bind_interrupts,
    exti::ExtiInput,
    gpio::{Level, Output, Pull, Speed},
    peripherals as p, rcc,
    spi::{self, Spi},
    time::Hertz,
    timer::{
        CaptureCompareInterruptHandler,
        input_capture::{CapturePin, InputCapture},
        low_level::CountingMode,
    },
    usart::{self, Uart},
};
use embassy_sync::{blocking_mutex::raw::CriticalSectionRawMutex, channel::Channel, mutex::Mutex};
use musical_lights_core::message::{MESSAGE_BAUD_RATE, Message};
use musical_stm32::sensors::{self, SensorDevice, SpiBus, State};
use static_cell::StaticCell;
use {defmt_rtt as _, panic_probe as _};
bind_interrupts!(struct Irqs {
    DMA2_STREAM7=>embassy_stm32::dma::InterruptHandler<p::DMA2_CH7>;
    DMA2_STREAM5=>embassy_stm32::dma::InterruptHandler<p::DMA2_CH5>;
    DMA2_STREAM3=>embassy_stm32::dma::InterruptHandler<p::DMA2_CH3>;
    DMA2_STREAM0=>embassy_stm32::dma::InterruptHandler<p::DMA2_CH0>;
    DMA1_STREAM6=>embassy_stm32::dma::InterruptHandler<p::DMA1_CH6>;
    DMA1_STREAM5=>embassy_stm32::dma::InterruptHandler<p::DMA1_CH5>;
    USART1=>usart::InterruptHandler<p::USART1>;
    USART2=>usart::InterruptHandler<p::USART2>;
    EXTI9_5=>embassy_stm32::exti::InterruptHandler<embassy_stm32::interrupt::typelevel::EXTI9_5>;
    TIM2=>CaptureCompareInterruptHandler<p::TIM2>;
});
#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let mut config = embassy_stm32::Config::default();
    config.rcc.hse = Some(rcc::Hse {
        freq: Hertz(25_000_000),
        mode: rcc::HseMode::Oscillator,
    });
    config.rcc.pll_src = rcc::PllSource::HSE;
    config.rcc.pll = Some(rcc::Pll {
        prediv: rcc::PllPreDiv::DIV25,
        mul: rcc::PllMul::MUL168,
        divp: Some(rcc::PllPDiv::DIV2),
        divq: Some(rcc::PllQDiv::DIV7),
        divr: None,
    });
    config.rcc.sys = rcc::Sysclk::PLL1_P;
    config.rcc.apb1_pre = rcc::APBPrescaler::DIV2;
    config.rcc.apb2_pre = rcc::APBPrescaler::DIV1;
    let p = embassy_stm32::init(config);
    static STATE: StaticCell<Mutex<CriticalSectionRawMutex, State>> = StaticCell::new();
    let state = STATE.init(Mutex::new(State::default()));
    static MESSAGES: Channel<CriticalSectionRawMutex, Message, 4> = Channel::new();
    static COMMANDS: Channel<CriticalSectionRawMutex, sensors::Control, 2> = Channel::new();
    let flash = sensors::BoardFlash(embassy_stm32::flash::Flash::new_blocking(p.FLASH));
    let journal = sensors::open_storage(flash, state).await;
    let mut link = usart::Config::default();
    link.baudrate = MESSAGE_BAUD_RATE;
    let uart = Uart::new(p.USART1, p.PA10, p.PB6, p.DMA2_CH7, p.DMA2_CH5, Irqs, link)
        .expect("UART allocation");
    let (tx, rx) = uart.split();
    let mut gps_config = usart::Config::default();
    gps_config.baudrate = 9600;
    let gps = Uart::new(
        p.USART2, p.PA3, p.PA2, p.DMA1_CH6, p.DMA1_CH5, Irqs, gps_config,
    )
    .expect("GPS UART allocation");
    let enable = Output::new(p.PB7, Level::High, Speed::Low); // HIGH enables product 746.
    let capture = InputCapture::new(
        p.TIM2,
        Some(CapturePin::new(p.PA0, Pull::None)),
        None,
        None,
        None,
        Irqs,
        Hertz(1_000_000),
        CountingMode::EdgeAlignedUp,
    );
    let mut spi_config = spi::Config::default();
    spi_config.frequency = Hertz(1_000_000);
    let spi = Spi::new(
        p.SPI1, p.PA5, p.PA7, p.PA6, p.DMA2_CH3, p.DMA2_CH0, Irqs, spi_config,
    );
    static BUS: StaticCell<SpiBus> = StaticCell::new();
    let bus = BUS.init(Mutex::new(spi));
    let accel: SensorDevice = SpiDevice::new(bus, Output::new(p.PA8, Level::High, Speed::VeryHigh));
    let mag: SensorDevice = SpiDevice::new(bus, Output::new(p.PA9, Level::High, Speed::VeryHigh));
    let radio: SensorDevice = SpiDevice::new(bus, Output::new(p.PB0, Level::High, Speed::VeryHigh));
    let dio = ExtiInput::new(p.PB5, p.EXTI5, Pull::Down, Irqs);
    let reset = Output::new(p.PB12, Level::High, Speed::Low);
    spawner.spawn(sensors::transmit(tx, MESSAGES.receiver()).unwrap());
    spawner.spawn(sensors::receive(rx, COMMANDS.sender()).unwrap());
    spawner.spawn(
        sensors::controller(journal, state, COMMANDS.receiver(), MESSAGES.sender()).unwrap(),
    );
    spawner.spawn(sensors::gps(gps, enable, state).unwrap());
    spawner.spawn(sensors::pps(capture, state).unwrap());
    spawner.spawn(sensors::imu(accel, mag, state, MESSAGES.sender()).unwrap());
    spawner.spawn(sensors::radio(radio, dio, reset, state, COMMANDS.sender()).unwrap());
    spawner.spawn(sensors::snapshots(state, MESSAGES.sender()).unwrap());
    // Acquisition does not depend on Hello or a display being attached.
}
