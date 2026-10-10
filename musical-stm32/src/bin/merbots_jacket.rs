#![no_std]
#![no_main]

use core::iter::{repeat, repeat_n};
use embassy_executor::Spawner;
use embassy_futures::join::join;
use embassy_stm32::{
    Config, Peri,
    adc::{Adc, AdcChannel, SampleTime},
    gpio::{Level, Output, Speed},
    peripherals::{ADC1, DMA1_CH4, DMA2_CH0, DMA2_CH2, PA0, PB5, PB15, SPI1, SPI2, TIM2},
    rcc::{APBPrescaler, Pll, PllMul, PllPDiv, PllPreDiv, Sysclk},
    spi::{Config as SpiConfig, Spi},
    time::{Hertz, mhz},
    timer::low_level::{MasterMode, RoundTo, Timer as HardwareTimer},
};
use embassy_sync::{
    blocking_mutex::raw::ThreadModeRawMutex,
    watch::{Receiver, Sender, Watch},
};
use embassy_time::{Duration, Instant, Ticker, Timer};
use musical_lights_core::{
    audio::{
        jacket::JacketAudio,
        loudness::SAMPLE_RATE,
        visual::{DISPLAY_BANDS, DisplaySnapshot},
    },
    lights::{
        Gradient,
        jacket::{self, PIXELS as MATRIX_N, WIDTH as MATRIX_X},
    },
    logging::{info, warn},
};
use smart_leds::{
    RGB8, SmartLedsWriteAsync, brightness,
    colors::{BLACK, BLUE, RED},
    gamma,
};
use ws2812_async::{Grb, Ws2812};
use {defmt_rtt as _, panic_probe as _};
const MIC_SAMPLES: usize = 512;

#[derive(Clone, Copy)]
struct PanelAudio {
    snapshot: DisplaySnapshot<DISPLAY_BANDS>,
    origin: Instant,
}

#[embassy_executor::task]
async fn blink_task(mut led: Output<'static>) {
    loop {
        led.set_high();
        Timer::after_millis(200).await;
        led.set_low();
        Timer::after_millis(5000).await;
    }
}

#[embassy_executor::task]
async fn mic_task(
    mic_adc: Peri<'static, ADC1>,
    mic_pin: Peri<'static, PA0>,
    mic_dma: Peri<'static, DMA2_CH0>,
    sample_timer: Peri<'static, TIM2>,
    tx: Sender<'static, ThreadModeRawMutex, PanelAudio, 1>,
) {
    let adc = Adc::new_with_config(
        mic_adc,
        embassy_stm32::adc::AdcConfig {
            resolution: Some(embassy_stm32::adc::Resolution::BITS12),
        },
    );
    let timer = HardwareTimer::new(sample_timer);
    timer.set_frequency(Hertz(SAMPLE_RATE), RoundTo::Slower);
    assert_eq!(timer.get_frequency().0, SAMPLE_RATE);
    timer.set_master_mode(MasterMode::UPDATE);
    let mut adc_dma_buf = [0u16; MIC_SAMPLES * 2];
    let mut adc = adc.into_ring_buffered(
        mic_dma,
        &mut adc_dma_buf,
        Irqs,
        [(mic_pin.degrade_adc(), SampleTime::CYCLES28)].into_iter(),
        embassy_stm32::triggers::TIM2_TRGO,
        embassy_stm32::adc::Exten::RISING_EDGE,
    );
    let mut audio = JacketAudio::default();
    info!("Jacket ADC: nominal 48000 Hz; microphone calibration unmeasured");
    let mut measurements = [0u16; MIC_SAMPLES];
    adc.start();
    let mut origin = Instant::now();
    timer.start();
    loop {
        // No PCM queue and no renderer wait: this task consumes every DMA block.
        match adc.read(&mut measurements).await {
            Ok(_) => {
                if audio.push_adc(&measurements).is_err() {
                    warn!("Jacket analysis failed; resetting acoustic state");
                    audio.reset();
                    adc.clear();
                    origin = Instant::now();
                }
            }
            Err(_) => {
                warn!("Jacket DMA gap; resetting acoustic state");
                audio.reset();
                // The driver resets its read cursor on overrun; discard any
                // samples captured during the analysis reset as well.
                adc.clear();
                origin = Instant::now();
            }
        }
        tx.send(PanelAudio {
            snapshot: audio.snapshot(),
            origin,
        });
        embassy_futures::yield_now().await;
    }
}

#[allow(clippy::too_many_arguments)]
#[embassy_executor::task]
async fn light_task(
    left_mosi: Peri<'static, PB5>,
    left_peri: Peri<'static, SPI1>,
    left_txdma: Peri<'static, DMA2_CH2>,
    right_mosi: Peri<'static, PB15>,
    right_peri: Peri<'static, SPI2>,
    right_txdma: Peri<'static, DMA1_CH4>,
    mut rx: Receiver<'static, ThreadModeRawMutex, PanelAudio, 1>,
) {
    let mut config = SpiConfig::default();
    config.frequency = mhz(38) / 10u32;
    config.mode = embassy_stm32::spi::MODE_0;
    let spi_left = Spi::new_txonly_nosck(left_peri, left_mosi, left_txdma, Irqs, config);
    let spi_right = Spi::new_txonly_nosck(right_peri, right_mosi, right_txdma, Irqs, config);
    let mut led_left = Ws2812::<_, Grb, MATRIX_N>::new(spi_left);
    let mut led_right = Ws2812::<_, Grb, MATRIX_N>::new(spi_right);
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
    let test_left_f = led_left.write(gamma(test_iter(BLUE)));
    let test_right_f = led_right.write(gamma(test_iter(RED)));

    let (left, right) = join(test_left_f, test_right_f).await;

    left.unwrap();
    right.unwrap();

    Timer::after_secs(2).await;

    let palette = Gradient::new_mermaid();
    let mut left_pixels = [BLACK; MATRIX_N];
    let mut right_pixels = [BLACK; MATRIX_N];
    let mut ticker = Ticker::every(Duration::from_millis(20));
    loop {
        ticker.next().await;
        let frame = rx.try_get().map_or_else(Default::default, |state| {
            state
                .snapshot
                .frame(state.origin.elapsed().as_micros() as f64 / 1_000_000.0)
        });
        jacket::render(&frame, &palette, &mut left_pixels, &mut right_pixels);
        let (left, right) = join(
            led_left.write(brightness(gamma(left_pixels.iter().copied()), 32)),
            led_right.write(brightness(gamma(right_pixels.iter().copied()), 32)),
        )
        .await;
        left.unwrap();
        right.unwrap();
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    // HSI 16 MHz / 8 × 96 / 2 = nominal 96 MHz. TIM2 divides exactly by 2000.
    // HSI tolerance still applies; this is not a measured sample-rate calibration.
    let mut config = Config::default();
    config.rcc.pll = Some(Pll {
        prediv: PllPreDiv::DIV8,
        mul: PllMul::MUL96,
        divp: Some(PllPDiv::DIV2),
        divq: None,
        divr: None,
    });
    config.rcc.sys = Sysclk::PLL1_P;
    config.rcc.apb1_pre = APBPrescaler::DIV2;
    let p = embassy_stm32::init(config);
    static AUDIO: Watch<ThreadModeRawMutex, PanelAudio, 1> = Watch::new();
    spawner.spawn(
        blink_task(Output::new(p.PC13, Level::High, Speed::Low)).expect("task allocation failed"),
    );
    spawner.spawn(
        light_task(
            p.PB5,
            p.SPI1,
            p.DMA2_CH2,
            p.PB15,
            p.SPI2,
            p.DMA1_CH4,
            AUDIO.receiver().unwrap(),
        )
        .expect("task allocation failed"),
    );
    spawner.spawn(
        mic_task(p.ADC1, p.PA0, p.DMA2_CH0, p.TIM2, AUDIO.sender())
            .expect("task allocation failed"),
    );
}

embassy_stm32::bind_interrupts!(struct Irqs {
    DMA2_STREAM0 => embassy_stm32::dma::InterruptHandler<embassy_stm32::peripherals::DMA2_CH0>;
    DMA2_STREAM2 => embassy_stm32::dma::InterruptHandler<embassy_stm32::peripherals::DMA2_CH2>;
    DMA1_STREAM4 => embassy_stm32::dma::InterruptHandler<embassy_stm32::peripherals::DMA1_CH4>;
});
