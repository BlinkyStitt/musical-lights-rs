//! Platform ownership: short state locks, bounded peripheral waits, no handshake gate.
use crate::sparkle_uart::{UartFromSparkle, UartToSparkle};
use embassy_embedded_hal::shared_bus::asynch::spi::SpiDevice;
use embassy_stm32::{
    exti::ExtiInput,
    gpio::Output,
    mode::Async,
    peripherals,
    spi::{self, Spi},
    timer::{Channel as TimerChannel, input_capture::InputCapture},
    usart::{Uart, UartRx, UartTx},
};
use embassy_sync::{
    blocking_mutex::raw::CriticalSectionRawMutex,
    channel::{Receiver, Sender},
    mutex::Mutex,
};
use embassy_time::{Delay, Duration, Instant, Timer, with_timeout};
use lsm9ds1::{self, accel, gyro, interface::SpiInterface, mag};
use musical_lights_core::{
    clock::{Anchor, UtcClock},
    controller::Controller,
    gps::{Fix, GpsParser, PpsCounter},
    message::*,
    navigation::{HeadingEstimator, ImuSample, declination},
    provisioning::{F4, StmRecord},
    radio::{self as wire, Network, Report},
    sensor_mount::ImuMounts,
    storage::{self, StorageError},
};
type Raw = CriticalSectionRawMutex;
pub type SpiBus = Mutex<Raw, Spi<'static, Async, spi::mode::Master>>;
pub type SensorDevice =
    SpiDevice<'static, Raw, Spi<'static, Async, spi::mode::Master>, Output<'static>>;
pub type Shared = &'static Mutex<Raw, State>;
type ImuError = <SpiInterface<SensorDevice, SensorDevice> as lsm9ds1::interface::Interface>::Error;
type Out = Sender<'static, Raw, Message, 4>;
/// A bounded mailbox item. Absence of a command requests a new durable boot.
pub struct Control {
    command: Option<Command>,
}
type Controls = Sender<'static, Raw, Control, 2>;
#[derive(Default)]
pub struct State {
    pub boot: u32,
    pub settings: Option<StmRecord<[u8; 32]>>,
    pub fix: Option<Fix>,
    pub heading: Heading,
    pub clock: UtcClock,
    pub network: Option<Network>,
    pub pps: Option<(u64, u64)>,
    pub radio_fault: bool,
    pub gps_fault: bool,
    pub sensor_fault: bool,
    pub storage_fault: bool,
    pub run: Option<musical_lights_core::controller::CalibrationRun>,
    pub preview: Heading,
    pub heading_at: u64,
    pub inertial_at: u64,
    pub parse_errors: u32,
    pub overruns: u32,
}
fn now() -> u64 {
    // TIM2 keeps counting while flash stalls code fetch. Extend its 32-bit
    // hardware count for acquisition ages; TIM5 schedules Embassy futures.
    static CLOCK: embassy_sync::blocking_mutex::Mutex<Raw, core::cell::RefCell<PpsCounter>> =
        embassy_sync::blocking_mutex::Mutex::new(core::cell::RefCell::new(PpsCounter::new()));
    CLOCK.lock(|counter| {
        counter
            .borrow_mut()
            .capture(embassy_stm32::pac::TIM2.cnt().read())
            / 1000
    })
}
pub struct BoardFlash(pub embassy_stm32::flash::Flash<'static, embassy_stm32::flash::Blocking>);
impl storage::Flash for BoardFlash {
    fn read(&mut self, offset: usize, data: &mut [u8]) -> Result<(), StorageError> {
        self.0
            .blocking_read(0x40000 + offset as u32, data)
            .map_err(|_| StorageError::Io)
    }
    fn write(&mut self, offset: usize, data: &[u8]) -> Result<(), StorageError> {
        self.0
            .blocking_write(0x40000 + offset as u32, data)
            .map_err(|_| StorageError::Io)
    }
    fn erase(&mut self, offset: usize, length: usize) -> Result<(), StorageError> {
        self.0
            .blocking_erase(0x40000 + offset as u32, 0x40000 + (offset + length) as u32)
            .map_err(|_| StorageError::Io)
    }
}
pub async fn open_storage(flash: BoardFlash, state: Shared) -> Option<Controller<BoardFlash>> {
    match Controller::boot(flash) {
        Ok(controller) => {
            let mut s = state.lock().await;
            s.boot = controller.boot_id();
            s.settings = controller.settings.clone();
            Some(controller)
        }
        Err(_) => {
            state.lock().await.storage_fault = true;
            None
        }
    }
}
#[embassy_executor::task]
pub async fn transmit(tx: UartTx<'static, Async>, messages: Receiver<'static, Raw, Message, 4>) {
    let mut tx = UartToSparkle::new(tx);
    loop {
        let message = messages.receive().await;
        if with_timeout(Duration::from_millis(100), tx.write(&message))
            .await
            .is_err()
        {
            defmt::warn!("board UART TX timeout");
        }
    }
}
#[embassy_executor::task]
pub async fn receive(rx: UartRx<'static, Async>, commands: Controls) {
    let mut rx = UartFromSparkle::new(rx);
    loop {
        let _ = rx
            .read_loop(|m| async move {
                if let Message::Command(command) = m {
                    let _ = commands.try_send(Control {
                        command: Some(command),
                    });
                }
            })
            .await;
        Timer::after_millis(100).await;
    }
}
#[embassy_executor::task]
pub async fn controller(
    mut controller: Option<Controller<BoardFlash>>,
    state: Shared,
    commands: Receiver<'static, Raw, Control, 2>,
    out: Out,
) {
    loop {
        let command = with_timeout(Duration::from_secs(1), commands.receive()).await;
        let Some(controller) = controller.as_mut() else {
            Timer::after_secs(1).await;
            continue;
        };
        controller.expire(now());
        if let Ok(command) = command {
            // F411 flash maintenance can stall code fetch. Publish unavailable
            // navigation before committing; require new acquisition afterward.
            if matches!(
                &command.command,
                None | Some(Command {
                    operation: 1 | 2 | 4 | 5,
                    ..
                })
            ) {
                let mut s = state.lock().await;
                s.fix = None;
                s.heading = Heading::default();
                s.clock = UtcClock::default();
                s.sensor_fault = true;
                s.gps_fault = true;
                s.pps = None;
            }
            match command.command {
                None => {
                    let _ = controller.next_boot();
                }
                Some(command) => {
                    let mut result = controller.command(&command, now());
                    if command.operation == 8
                        && command.data.is_empty()
                        && command.expected_generation.get() == 0
                    {
                        let s = state.lock().await;
                        result.status = 0;
                        result.data.clear();
                        let hdop = s
                            .fix
                            .and_then(|f| f.hdop)
                            .map_or(u16::MAX, |h| (h * 100.0).clamp(0.0, 65534.0) as u16);
                        let pps_age = s.pps.map_or(u32::MAX, |(_, at)| {
                            now().saturating_sub(at).min(u32::MAX as u64) as u32
                        });
                        result.data.extend_from_slice(&1u16.to_le_bytes()).unwrap();
                        result.data.extend_from_slice(&hdop.to_le_bytes()).unwrap();
                        result
                            .data
                            .extend_from_slice(&u32::MAX.to_le_bytes())
                            .unwrap();
                        result
                            .data
                            .extend_from_slice(&pps_age.to_le_bytes())
                            .unwrap();
                        result
                            .data
                            .extend_from_slice(&s.parse_errors.to_le_bytes())
                            .unwrap();
                        result
                            .data
                            .extend_from_slice(&s.overruns.to_le_bytes())
                            .unwrap();
                    }
                    if command.operation == 10 && result.status == 0 && result.data.len() == 47 {
                        let preview = state.lock().await.preview;
                        let mut bytes = [0; 15];
                        postcard::to_slice(&preview, &mut bytes).unwrap();
                        result.data[32..].copy_from_slice(&bytes);
                    }
                    out.send(Message::CommandResult(result)).await;
                }
            }
        }
        let mut s = state.lock().await;
        s.boot = controller.boot_id();
        s.settings = controller.settings.clone();
        s.run = controller.run.clone();
        s.storage_fault = controller.storage_fault;
    }
}
#[embassy_executor::task]
pub async fn pps(mut capture: InputCapture<'static, peripherals::TIM2>, state: Shared) {
    let mut counter = PpsCounter::default();
    loop {
        match with_timeout(
            Duration::from_secs(2),
            capture.wait_for_rising_edge(TimerChannel::Ch1),
        )
        .await
        {
            Ok(value) => {
                let extended = counter.capture(value);
                state.lock().await.pps = Some((extended, now()));
            }
            Err(_) => {
                let _ = counter.capture(embassy_stm32::pac::TIM2.cnt().read());
                state.lock().await.pps = None;
            }
        }
    }
}
#[embassy_executor::task]
pub async fn gps(mut uart: Uart<'static, Async>, _enable: Output<'static>, state: Shared) {
    for command in [
        b"$PMTK220,1000*1F\r\n".as_slice(),
        b"$PMTK314,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0*28\r\n".as_slice(),
    ] {
        let _ = with_timeout(Duration::from_millis(500), uart.write(command)).await;
    }
    let mut parser = GpsParser::default();
    let mut line = heapless::Vec::<u8, 96>::new();
    let mut discarding = false;
    let mut input = [0; 192];
    loop {
        match with_timeout(Duration::from_secs(3), uart.read_until_idle(&mut input)).await {
            Ok(Ok(length)) => {
                state.lock().await.gps_fault = false;
                for &byte in &input[..length] {
                    if byte == b'\n' {
                        if !discarding && let Ok(text) = core::str::from_utf8(&line) {
                            if let Some(fix) = parser.push(text, now()) {
                                let mut s = state.lock().await;
                                if let Some((_, pps_at)) = s.pps.filter(|(_, at)| {
                                    fix.time_valid
                                        && fix.captured_ms >= *at
                                        && fix.captured_ms - *at < 1000
                                }) {
                                    // Timing bound is deliberately unknown until the product-746
                                    // PPS/epoch association is physically characterized.
                                    s.clock.accept(Anchor {
                                        utc_ms: fix.utc_ms,
                                        monotonic_ms: pps_at,
                                        uncertainty_ms: u32::MAX,
                                    });
                                }
                                s.fix = Some(fix);
                            } else if text.contains('*') && nmea_checksum_bad(text) {
                                let mut s = state.lock().await;
                                s.parse_errors = s.parse_errors.saturating_add(1);
                            }
                        }
                        line.clear();
                        discarding = false;
                    } else if !discarding && line.push(byte).is_err() {
                        discarding = true;
                        let mut s = state.lock().await;
                        s.overruns = s.overruns.saturating_add(1);
                    }
                }
            }
            _ => {
                state.lock().await.gps_fault = true;
                line.clear();
                discarding = true;
            }
        }
    }
}
fn nmea_checksum_bad(line: &str) -> bool {
    let line = line.trim_end_matches('\r');
    let Some(star) = line.find('*') else {
        return true;
    };
    if star + 3 != line.len() || !line.starts_with('$') {
        return true;
    }
    let expected = u8::from_str_radix(&line[star + 1..], 16).ok();
    expected
        != Some(
            line.as_bytes()[1..star]
                .iter()
                .fold(0, |crc, byte| crc ^ byte),
        )
}
#[embassy_executor::task]
pub async fn imu(accel_device: SensorDevice, mag_device: SensorDevice, state: Shared, out: Out) {
    let mut imu = lsm9ds1::LSM9DS1Init {
        accel: accel::AccelSettings {
            sample_rate: accel::ODR::_119Hz,
            scale: accel::Scale::_4G,
            ..Default::default()
        },
        gyro: gyro::GyroSettings {
            sample_rate: gyro::ODR::_119Hz,
            scale: gyro::Scale::_245DPS,
            ..Default::default()
        },
        mag: mag::MagSettings {
            sample_rate: mag::ODR::_80Hz,
            scale: mag::Scale::_4G,
            i2c_mode: mag::I2cMode::Disabled,
            spi_mode: mag::SpiMode::RW,
            ..Default::default()
        },
    }
    .with_interface(SpiInterface::init(accel_device, mag_device));
    let initialized = async {
        if !imu.accel_is_reacheable().await? || !imu.mag_is_reacheable().await? {
            return Ok(false);
        }
        imu.begin_accel().await?;
        imu.begin_gyro().await?;
        imu.begin_mag().await?;
        Ok::<bool, ImuError>(true)
    };
    // The existing SPI interface error is (), and every operation is bounded.
    if !matches!(
        with_timeout(Duration::from_secs(1), initialized).await,
        Ok(Ok(true))
    ) {
        state.lock().await.sensor_fault = true;
        return;
    }
    let mut heading = HeadingEstimator::default();
    let mut preview = HeadingEstimator::default();
    let mut sample = ImuSample {
        accel: [0.0; 3],
        gyro: [0.0; 3],
        mag: [0.0; 3],
        accel_at: 0,
        gyro_at: 0,
        mag_at: 0,
        saturated: false,
    };
    let mut valid = 0u8;
    let mut samples = heapless::Vec::<RawSample, 8>::new();
    let mut run_id = None;
    let mut batch = 0u32;
    let mut overrun = 0u32;
    let mut last_record = 0;
    let mut last_batch = 0;
    loop {
        let at = now();
        let mut new_gyro = false;
        let acquire = async {
            if imu.accel_data_available().await? {
                let (x, y, z) = imu.read_accel_raw().await?;
                sample.accel = [x, y, z].map(|v| v as f64 * 0.000122 * 9.80665);
                sample.accel_at = at;
                valid |= 1;
                sample.saturated = [x, y, z].iter().any(|v| v.unsigned_abs() >= 32760);
            }
            if imu.gyro_data_available().await? {
                let (x, y, z) = imu.read_gyro_raw().await?;
                sample.gyro = [x, y, z].map(|v| (v as f64 * 0.00875).to_radians());
                sample.gyro_at = at;
                valid |= 2;
                new_gyro = true;
                sample.saturated |= [x, y, z].iter().any(|v| v.unsigned_abs() >= 32760);
            }
            if imu.mag_data_available().await? {
                let (x, y, z) = imu.read_mag_raw().await?;
                sample.mag = [x, y, z].map(|v| v as f64 * 0.014);
                sample.mag_at = at;
                valid |= 4;
                sample.saturated |= [x, y, z].iter().any(|v| v.unsigned_abs() >= 32760);
            }
            Ok::<(), ImuError>(())
        };
        if !matches!(
            with_timeout(Duration::from_millis(40), acquire).await,
            Ok(Ok(()))
        ) {
            state.lock().await.sensor_fault = true;
            return;
        }
        let (calibration, fix, run, boot) = {
            let s = state.lock().await;
            (
                s.settings.as_ref().and_then(|s| s.calibration.clone()),
                s.fix,
                s.run.clone(),
                s.boot,
            )
        };
        if new_gyro {
            let declination = fix.filter(|f| f.age_ms(at) <= 60000).and_then(declination);
            let mut value = heading.update(
                sample,
                calibration.as_ref(),
                ImuMounts::default(),
                declination,
                at,
            );
            let candidate = run.as_ref().and_then(|r| r.candidate.as_ref());
            let candidate_heading =
                preview.update(sample, candidate, ImuMounts::default(), declination, at);
            if run.is_some() {
                value.quality = 2;
                value.magnetic = L2::new(0);
                value.true_north = L2::new(0);
            }
            let mut s = state.lock().await;
            s.heading = value;
            s.heading_at = at;
            s.inertial_at = sample.accel_at.min(sample.gyro_at);
            s.preview = candidate_heading;
            s.sensor_fault = false;
        }
        let active = run.filter(|r| r.stream);
        if active.as_ref().map(|r| r.id) != run_id {
            run_id = active.as_ref().map(|r| r.id);
            samples.clear();
            batch = 0;
            overrun = 0;
        }
        if at.saturating_sub(last_record) >= 10 && valid != 0 && active.is_some() {
            let vector = |values: [f64; 3], bit: u8| {
                if valid & bit != 0 {
                    values.map(|v| F4::new(v as f32).0)
                } else {
                    [[0; 4]; 3]
                }
            };
            let record = RawSample {
                captured_at: L4::new(at as u32),
                valid,
                accel: vector(sample.accel, 1),
                gyro: vector(sample.gyro, 2),
                mag: vector(sample.mag, 4),
            };
            if samples.push(record).is_err() {
                overrun = overrun.saturating_add(1);
            }
            valid = 0;
            last_record = at;
        }
        if !samples.is_empty() && (samples.is_full() || at.saturating_sub(last_batch) >= 80) {
            if let (Some(id), Some(next)) = (run_id, batch.checked_add(1)) {
                batch = next;
                let records = core::mem::take(&mut samples);
                let count = records.len() as u32;
                if out
                    .try_send(Message::CalibrationBatch(CalibrationBatch {
                        stm_boot: L4::new(boot),
                        run_id: id,
                        batch_sequence: L4::new(batch),
                        overrun_samples: L4::new(overrun),
                        samples: records,
                    }))
                    .is_err()
                {
                    overrun = overrun.saturating_add(count);
                }
            }
            last_batch = at;
        }
        Timer::after_millis(5).await;
    }
}

fn health(s: &State, at: u64) -> u16 {
    let mut flags = wire::BATTERY_UNKNOWN;
    if s.sensor_fault {
        flags |= wire::SENSOR_FAULT;
    }
    if s.gps_fault {
        flags |= wire::GPS_FAULT;
    }
    if s.radio_fault {
        flags |= wire::RADIO_FAULT;
    }
    if s.clock.utc(at).is_none() {
        flags |= wire::CLOCK_UNTRUSTED;
    }
    if s.run.is_some() {
        flags |= wire::CALIBRATING;
    }
    if at.saturating_sub(s.inertial_at) <= 50
        && !s.sensor_fault
        && s.run.is_none()
        && s.heading.age.get() as u64 + at.saturating_sub(s.heading_at) <= 200
    {
        if matches!(s.heading.quality, 3 | 4) {
            flags |= wire::HEADING_VALID;
        }
        if s.heading.quality == 3 {
            flags |= wire::MAGNETIC_ONLY;
        }
    }
    if !s.gps_fault && s.fix.is_some_and(|f| f.valid && f.age_ms(at) <= 60000) {
        flags |= wire::POSITION_VALID;
        if s.clock.utc(at).is_some() {
            flags |= wire::SAMPLE_UTC_VALID;
        }
    }
    flags
}
fn position(s: &State, at: u64) -> Position {
    if health(s, at) & wire::POSITION_VALID == 0 {
        return Position::default();
    }
    let fix = s.fix.unwrap();
    Position {
        lat: L4::new(fix.latitude_e7 as u32),
        lon: L4::new(fix.longitude_e7 as u32),
        age: L4::new(fix.age_ms(at)),
        accuracy: L2::new(u16::MAX),
        flags: L2::new(health(s, at) & 7),
    }
}
#[embassy_executor::task]
pub async fn snapshots(state: Shared, out: Out) {
    let mut sequence = 0u32;
    let mut boot = 0u32;
    let mut hello_at = 0;
    loop {
        let at = now();
        let mut s = state.lock().await;
        s.clock.update(at);
        if s.boot != boot {
            boot = s.boot;
            sequence = 0;
        }
        if boot != 0 && !s.storage_fault {
            if at.saturating_sub(hello_at) >= 1000 {
                let _ = out.try_send(Message::Hello(Hello {
                    role: 0,
                    boot: L4::new(boot),
                    firmware: firmware_id(),
                    capabilities: L2::new(0x0b),
                    settings_generation: L4::new(
                        s.settings.as_ref().map_or(0, |s| s.generation.get()),
                    ),
                }));
                hello_at = at;
            }
            if let Some(next) = sequence.checked_add(1) {
                sequence = next;
                let mut snapshot = StateSnapshot {
                    boot: L4::new(boot),
                    sequence: L4::new(sequence),
                    uptime: L4::new(at as u32),
                    local: position(&s, at),
                    health: L2::new(health(&s, at)),
                    heading: s.heading,
                    slot: 255,
                    ..Default::default()
                };
                snapshot.heading.age = L2::new(
                    (snapshot.heading.age.get() as u64 + at.saturating_sub(s.heading_at))
                        .min(u16::MAX as u64) as u16,
                );
                if snapshot.heading.age.get() > 200
                    || at.saturating_sub(s.inertial_at) > 50
                    || s.sensor_fault
                {
                    snapshot.heading.quality = 0;
                    snapshot.heading.magnetic = L2::new(0);
                    snapshot.heading.true_north = L2::new(0);
                }
                snapshot.clock.state = match s.clock.state() {
                    musical_lights_core::clock::ClockState::Untrusted => 0,
                    musical_lights_core::clock::ClockState::Acquiring => 1,
                    musical_lights_core::clock::ClockState::Locked => 2,
                    musical_lights_core::clock::ClockState::Holdover => 3,
                };
                if let Some(anchor) = s.clock.anchor().filter(|_| {
                    matches!(
                        s.clock.state(),
                        musical_lights_core::clock::ClockState::Locked
                            | musical_lights_core::clock::ClockState::Holdover
                    )
                }) {
                    snapshot.clock.utc_anchor = L8::new(anchor.utc_ms);
                    snapshot.clock.anchor_age =
                        L4::new(at.saturating_sub(anchor.monotonic_ms).min(u32::MAX as u64) as u32);
                    snapshot.clock.uncertainty = L4::new(anchor.uncertainty_ms);
                }
                if let Some(settings) = &s.settings {
                    snapshot.settings_generation = settings.generation;
                    snapshot.roster_revision = settings.roster_revision;
                    snapshot.slot = settings
                        .network_roster()
                        .slot(settings.device_id.get())
                        .unwrap_or(255);
                    snapshot.count = settings.roster.len() as u8;
                }
                if let Some(network) = &s.network {
                    for peer in network.peers.iter().flatten() {
                        let r = peer.report;
                        if r.flags & wire::POSITION_VALID == 0 || peer.age(at) > 60000 {
                            continue;
                        }
                        let _ = snapshot.peers.push(Peer {
                            id: L2::new(r.origin),
                            origin_boot: L4::new(r.boot),
                            sequence: L4::new(r.sequence),
                            position: Position {
                                lat: L4::new(r.latitude_e7 as u32),
                                lon: L4::new(r.longitude_e7 as u32),
                                age: L4::new(peer.age(at)),
                                accuracy: L2::new(r.accuracy_dm),
                                flags: L2::new(r.flags & 7),
                            },
                            health: L2::new(r.flags),
                            hop: r.hop,
                            rssi: L2::new(i16::MIN as u16),
                            snr: i8::MIN as u8,
                            color: r.color,
                        });
                    }
                }
                let _ = out.try_send(Message::StateSnapshot(snapshot));
            }
        }
        let calibrating = s.run.is_some();
        drop(s);
        Timer::after_millis(if calibrating { 200 } else { 50 }).await;
    }
}
#[embassy_executor::task]
pub async fn radio(
    spi: SensorDevice,
    dio: ExtiInput<'static, Async>,
    reset: Output<'static>,
    state: Shared,
    commands: Controls,
) {
    use lora_phy::{
        LoRa,
        iv::GenericSx127xInterfaceVariant,
        mod_params::{Bandwidth, CodingRate, RxMode, SpreadingFactor},
        sx127x::{Config, Sx127x, Sx1276},
    };
    let interface = match GenericSx127xInterfaceVariant::new(reset, dio, None, None) {
        Ok(v) => v,
        Err(_) => {
            state.lock().await.radio_fault = true;
            return;
        }
    };
    let radio = Sx127x::new(
        spi,
        interface,
        Config {
            chip: Sx1276,
            tcxo_used: false,
            tx_boost: true,
            rx_boost: true,
        },
    );
    let mut radio = match with_timeout(Duration::from_secs(2), LoRa::new(radio, false, Delay)).await
    {
        Ok(Ok(r)) => r,
        _ => {
            state.lock().await.radio_fault = true;
            return;
        }
    };
    let modulation = match radio.create_modulation_params(
        SpreadingFactor::_7,
        Bandwidth::_250KHz,
        CodingRate::_4_5,
        915000000,
    ) {
        Ok(v) => v,
        Err(_) => {
            state.lock().await.radio_fault = true;
            return;
        }
    };
    let mut tx = radio
        .create_tx_packet_params(8, false, true, false, &modulation)
        .unwrap();
    let rx = radio
        .create_rx_packet_params(8, false, 63, true, false, &modulation)
        .unwrap();
    let mut random = 0x9e3779b9u32 ^ (Instant::now().as_ticks() as u32);
    let mut roll = || {
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        random
    };
    let mut configured_generation = 0;
    let mut sequence = 0u32;
    let mut boot = 0;
    let mut own_due = now() + roll() as u64 % 5001;
    let mut own_deadline = own_due + 1000;
    let mut payload = [0; 63];
    let mut receiving = false;
    loop {
        let at = now();
        let settings = {
            let mut s = state.lock().await;
            let settings = s.settings.clone();
            if let Some(settings) = &settings
                && configured_generation != settings.generation.get()
            {
                s.network = Network::new(
                    settings.device_id.get(),
                    settings.group_id.get(),
                    settings.network_roster(),
                    settings.relay_enabled,
                );
                configured_generation = settings.generation.get();
                own_due = at + ((roll() ^ settings.device_id.get() as u32 ^ s.boot) as u64) % 5001;
                own_deadline = own_due + 1000;
            }
            if s.boot != boot {
                boot = s.boot;
                sequence = 0;
            }
            settings
        };
        let source_due = settings.is_some() && boot != 0 && at >= own_due;
        let relay_due = {
            let s = state.lock().await;
            s.network.as_ref().is_some_and(|n| n.has_due_relay(at))
        };
        if source_due || relay_due {
            let busy = match with_timeout(Duration::from_millis(200), async {
                radio.prepare_for_cad(&modulation).await?;
                radio.cad(&modulation).await
            })
            .await
            {
                Ok(Ok(busy)) => busy,
                _ => {
                    state.lock().await.radio_fault = true;
                    return;
                }
            };
            receiving = false;
            let at = now(); // Include CAD time in freshness and relay residence.
            if source_due && busy && at <= own_deadline {
                Timer::after_millis(20 + roll() as u64 % 81).await;
                continue;
            }
            let report = if source_due {
                own_due =
                    at + settings.as_ref().unwrap().interval_ms.get() as u64 + roll() as u64 % 501
                        - 250;
                own_deadline = own_due + 1000;
                if busy {
                    None
                } else if let Some(next) = sequence.checked_add(1) {
                    sequence = next;
                    let s = state.lock().await;
                    let config = settings.as_ref().unwrap();
                    let flags = health(&s, at);
                    let fix = s.fix.filter(|_| flags & wire::POSITION_VALID != 0);
                    Some(Report {
                        group: config.group_id.get(),
                        origin: config.device_id.get(),
                        relay: config.device_id.get(),
                        boot,
                        sequence,
                        utc_ms: fix
                            .filter(|_| flags & wire::SAMPLE_UTC_VALID != 0)
                            .map_or(0, |f| f.utc_ms),
                        age_ms: fix.map_or(0, |f| f.age_ms(at)),
                        latitude_e7: fix.map_or(0, |f| f.latitude_e7),
                        longitude_e7: fix.map_or(0, |f| f.longitude_e7),
                        accuracy_dm: if fix.is_some() { u16::MAX } else { 0 },
                        color: config
                            .network_roster()
                            .identity(config.device_id.get())
                            .unwrap()
                            .color,
                        flags,
                        hop: 1,
                    })
                } else {
                    let _ = commands.try_send(Control { command: None });
                    None
                }
            } else {
                let mut s = state.lock().await;
                s.network
                    .as_mut()
                    .and_then(|n| n.next_relay(at, false, busy, roll()))
            };
            if let (Some(report), Some(settings)) = (report, &settings) {
                if state.lock().await.storage_fault {
                    Timer::after_secs(1).await;
                    continue;
                }
                if let Ok(packet) = report.encode(&settings.key) {
                    payload[..4].copy_from_slice(&[255, 0, 0, 0]);
                    payload[4..].copy_from_slice(&packet);
                    let send = async {
                        radio
                            .prepare_for_tx(&modulation, &mut tx, 13, &payload)
                            .await?;
                        radio.tx().await
                    };
                    if !matches!(
                        with_timeout(Duration::from_millis(300), send).await,
                        Ok(Ok(()))
                    ) {
                        state.lock().await.radio_fault = true;
                        return;
                    }
                }
            }
        }
        if !receiving {
            if !matches!(
                with_timeout(
                    Duration::from_millis(100),
                    radio.prepare_for_rx(RxMode::Continuous, &modulation, &rx)
                )
                .await,
                Ok(Ok(()))
            ) {
                state.lock().await.radio_fault = true;
                return;
            }
            receiving = true;
        }
        match with_timeout(Duration::from_millis(100), radio.rx(&rx, &mut payload)).await {
            Ok(Ok((63, _))) if payload[..4] == [255, 0, 0, 0] => {
                if let Some(settings) = &settings
                    && let Ok(report) = Report::decode(&payload[4..], &settings.key)
                {
                    let mut s = state.lock().await;
                    let utc = s.clock.utc(now());
                    if let Some(network) = s.network.as_mut() {
                        let _ = network.receive(report, now(), utc, roll());
                    }
                }
            }
            Ok(Err(lora_phy::mod_params::RadioError::ReceiveTimeout)) | Err(_) => {}
            Ok(Ok(_)) => {}
            _ => {
                state.lock().await.radio_fault = true;
                return;
            }
        }
    }
}

fn firmware_id() -> [u8; 8] {
    let revision = env!("FIRMWARE_REVISION");
    core::array::from_fn(|i| {
        u8::from_str_radix(&revision[i * 2..i * 2 + 2], 16).expect("hex source revision")
    })
}
