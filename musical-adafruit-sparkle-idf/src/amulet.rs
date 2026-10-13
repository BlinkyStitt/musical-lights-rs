//! Four-output amulet with wired settings, atomic NVS and independent board acquisition.
use crate::capture::Capture;
use base64::{engine::general_purpose::STANDARD, Engine};
use esp_idf_svc::{
    hal::{
        gpio::{Gpio25, Gpio26, Gpio33},
        i2s::I2S0,
        peripherals::Peripherals,
        uart::{config::Config, UartDriver},
        units::Hertz,
    },
    handle::RawHandle,
    nvs::{EspDefaultNvsPartition, EspNvs, NvsDefault},
    sys,
};
use musical_lights_core::{
    amulet::{Renderer, PIXELS},
    amulet_output,
    audio::{
        loudness::SoundField, parse_i2s_16_bit_mono_to_f32_array, processor::LoudnessProcessor,
        settings::AudioSettings,
    },
    lights::LedResponse,
    message::*,
    provisioning::{self, RosterEntry, SparkleRecord, StmRecord},
};
use palette::LinSrgb;
use serde::{Deserialize, Serialize};
use smart_leds::RGB8;
use smart_leds_trait::SmartLedsWrite;
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use ws2812_esp32_rmt_driver::{driver::color::LedPixelColorImpl, LedPixelEsp32Rmt};
type Pixels<'a> = LedPixelEsp32Rmt<'a, RGB8, LedPixelColorImpl<3, 1, 0, 2, 255>>;
// A slow USB host cannot hold the display loop or board receiver. Dropped
// lines are reported; sequence gaps invalidate a calibration capture.
static CONSOLE_OUTPUT: OnceLock<flume::Sender<String>> = OnceLock::new();
static CONSOLE_DROPS: AtomicU32 = AtomicU32::new(0);
macro_rules! reply {
    ($($args:tt)*) => {{
        let line = format!($($args)*);
        if line.len() > 1024 || CONSOLE_OUTPUT.get().is_none_or(|out| out.try_send(line).is_err()) {
            CONSOLE_DROPS.fetch_add(1, Ordering::Relaxed);
        }
    }};
}
const CRC: crc::Crc<u32> = crc::Crc::<u32>::new(&crc::CRC_32_ISO_HDLC);
#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    schema: L2,
    boot: L4,
    client_epoch: L4,
    next_command: L4,
    settings: SparkleRecord,
    pending: Option<Command>,
}
struct Storage {
    nvs: EspNvs<NvsDefault>,
    record: Stored,
    fault: bool,
}
impl Storage {
    fn open() -> eyre::Result<Self> {
        let partition = EspDefaultNvsPartition::take_with(false)?;
        let nvs = EspNvs::new(partition, "amulet", true)?;
        let mut bytes = vec![0; 4096];
        let mut record = if let Some(data) = nvs.get_blob("state", &mut bytes)? {
            eyre::ensure!(data.len() >= 4, "invalid NVS record");
            let n = data.len() - 4;
            eyre::ensure!(
                CRC.checksum(&data[..n]) == u32::from_le_bytes(data[n..].try_into().unwrap()),
                "NVS CRC failure"
            );
            let (record, remaining): (Stored, _) = postcard::take_from_bytes(&data[..n])?;
            let mut canonical = vec![0; 4096];
            eyre::ensure!(
                remaining.is_empty()
                    && postcard::to_slice(&record, &mut canonical)? == &data[..n]
                    && record.schema.get() == 1,
                "invalid NVS schema"
            );
            eyre::ensure!(
                record.settings.generation.get() == 0 || record.settings.valid(),
                "invalid stored settings"
            );
            record
        } else {
            Stored {
                schema: L2::new(1),
                boot: L4::new(0),
                client_epoch: L4::new(1),
                next_command: L4::new(1),
                settings: SparkleRecord::default(),
                pending: None,
            }
        };
        record.boot = L4::new(
            record
                .boot
                .get()
                .checked_add(1)
                .ok_or_else(|| eyre::eyre!("boot counter exhausted"))?,
        );
        let mut storage = Self {
            nvs,
            record: record.clone(),
            fault: false,
        };
        storage.save(record)?;
        Ok(storage)
    }
    fn save(&mut self, record: Stored) -> eyre::Result<()> {
        eyre::ensure!(!self.fault, "storage requires recovery");
        let mut bytes = vec![0; 4096];
        let n = postcard::to_slice(&record, &mut bytes[..4092])?.len();
        let crc = CRC.checksum(&bytes[..n]);
        bytes[n..n + 4].copy_from_slice(&crc.to_le_bytes());
        // The pinned EspNvs::set_blob erases the key first. Use the SDK's atomic
        // replacement directly; never acknowledge an erase-then-write sequence.
        let result = unsafe {
            sys::nvs_set_blob(
                self.nvs.handle(),
                c"state".as_ptr(),
                bytes.as_ptr().cast(),
                n + 4,
            )
        };
        if result != sys::ESP_OK || unsafe { sys::nvs_commit(self.nvs.handle()) } != sys::ESP_OK {
            self.fault = true;
            eyre::bail!("NVS write failed");
        }
        let mut verify = vec![0; 4096];
        if !matches!(self.nvs.get_blob("state", &mut verify), Ok(Some(data)) if data == &bytes[..n + 4])
        {
            self.fault = true;
            eyre::bail!("NVS readback failed");
        }
        self.record = record;
        Ok(())
    }
    fn settings(&mut self, mut settings: SparkleRecord) -> eyre::Result<()> {
        settings.generation = L4::new(
            self.record
                .settings
                .generation
                .get()
                .checked_add(1)
                .ok_or_else(|| eyre::eyre!("generation exhausted"))?,
        );
        eyre::ensure!(settings.valid(), "invalid settings or missing power limits");
        let mut next = self.record.clone();
        next.settings = settings;
        self.save(next)
    }
}
#[derive(Default)]
struct Audio {
    level: f32,
    fault: bool,
}
fn microphone(
    mut i2s: I2S0,
    mut bclk: Gpio26,
    mut ws: Gpio33,
    mut din: Gpio25,
    enabled: Arc<AtomicBool>,
    state: Arc<Mutex<Audio>>,
) {
    loop {
        while !enabled.load(Ordering::Relaxed) {
            *state.lock().unwrap() = Audio::default();
            thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: This task owns the tokens. The capture and all its borrows
        // end at the inner scope before another capture can start.
        let result = (|| -> eyre::Result<()> {
            let mut capture = Capture::new(
                unsafe { i2s.reborrow() },
                unsafe { bclk.reborrow() },
                unsafe { ws.reborrow() },
                unsafe { din.reborrow() },
                768,
            )?;
            let mut processor = LoudnessProcessor::new(
                crate::light_profile::input_calibration()?,
                SoundField::Free,
                AudioSettings::default(),
            );
            processor.set_microphone(true);
            let mut samples = 0;
            let mut input = [0; 1536];
            let mut pcm = [0.0; 768];
            while enabled.load(Ordering::Relaxed) {
                capture.read_exact(&mut input)?;
                parse_i2s_16_bit_mono_to_f32_array(&input, &mut pcm);
                let mut level = 0.0f32;
                processor.push_pcm(&pcm, samples, false, |frame| {
                    level = frame.snapshot.filtered.iter().copied().fold(0.0, f32::max)
                })?;
                samples += 768;
                state.lock().unwrap().level = level;
            }
            Ok(())
        })();
        if result.is_err() {
            let mut value = state.lock().unwrap();
            value.level = 0.0;
            value.fault = true;
            drop(value);
            while enabled.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
fn from_hex<const N: usize>(text: &str) -> Option<heapless::Vec<u8, N>> {
    if !text.len().is_multiple_of(2) || text.len() / 2 > N {
        return None;
    }
    let mut bytes = heapless::Vec::new();
    for pair in text.as_bytes().as_chunks::<2>().0 {
        let s = core::str::from_utf8(pair).ok()?;
        bytes.push(u8::from_str_radix(s, 16).ok()?).ok()?;
    }
    Some(bytes)
}
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut text = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(&mut text, "{b:02x}").unwrap();
    }
    text
}

fn default_stm() -> StmRecord<Option<[u8; 32]>> {
    StmRecord {
        schema: L2::new(1),
        generation: L4::new(1),
        device_id: L2::new(0),
        group_id: L4::new(0),
        key_id: L4::new(0),
        key: None,
        roster_revision: L4::new(0),
        roster: heapless::Vec::new(),
        radio_profile: L2::new(1),
        interval_ms: L4::new(5000),
        relay_enabled: false,
        sensor_profile: L2::new(1),
        mount_revision: L4::new(1),
        gps_profile: L2::new(1),
        battery_profile: L2::new(0),
        calibration: None,
    }
}
fn set_stm(s: &mut StmRecord<Option<[u8; 32]>>, key: &str, value: &str) -> bool {
    let number = value.parse::<u32>().ok();
    match key {
        "identity.device_id" => {
            if let Some(v) = number.filter(|v| (1..65535).contains(v)) {
                s.device_id = L2::new(v as u16);
            } else {
                return false;
            }
        }
        "identity.group_id" => {
            if let Some(v) = number.filter(|v| *v > 0) {
                s.group_id = L4::new(v);
            } else {
                return false;
            }
        }
        "identity.key_id" => {
            if let Some(v) = number.filter(|v| *v > 0) {
                s.key_id = L4::new(v);
            } else {
                return false;
            }
        }
        "peers.revision" => {
            if let Some(v) = number.filter(|v| *v > 0) {
                s.roster_revision = L4::new(v);
            } else {
                return false;
            }
        }
        "peers.roster" => {
            let mut peers = heapless::Vec::new();
            for pair in value.split(',') {
                let Some((id, color)) = pair.split_once(':') else {
                    return false;
                };
                let (Ok(id), Ok(color)) = (id.parse::<u16>(), color.parse::<u8>()) else {
                    return false;
                };
                if peers
                    .push(RosterEntry {
                        id: L2::new(id),
                        color,
                    })
                    .is_err()
                {
                    return false;
                }
            }
            s.roster = peers;
        }
        "radio.relay_enabled" => {
            s.relay_enabled = match value {
                "true" => true,
                "false" => false,
                _ => return false,
            }
        }
        "radio.interval_ms" => {
            if let Some(v) = number.filter(|v| (5000..=60000).contains(v)) {
                s.interval_ms = L4::new(v);
            } else {
                return false;
            }
        }
        "sensors.mount_revision" => {
            if let Some(v) = number.filter(|v| *v > 0) {
                s.mount_revision = L4::new(v);
                s.calibration = None;
            } else {
                return false;
            }
        }
        _ => return false,
    }
    true
}

struct Console {
    sparkle: Option<SparkleRecord>,
    stm: Option<StmRecord<Option<[u8; 32]>>>,
    stm_generation: u32,
    reading: Option<(u32, bool)>,
    secret_until: Option<Instant>,
    last_send: Instant,
    request: Option<Command>,
    calibration: Option<([u8; 8], bool, bool, Instant)>,
}
impl Console {
    fn new() -> Self {
        Self {
            sparkle: None,
            stm: None,
            stm_generation: 0,
            reading: None,
            secret_until: None,
            last_send: Instant::now() - Duration::from_secs(2),
            request: None,
            calibration: None,
        }
    }
    fn command(
        &mut self,
        storage: &mut Storage,
        boot: u32,
        operation: u8,
        generation: u32,
        data: heapless::Vec<u8, 384>,
        tx: &flume::Sender<Message>,
    ) -> eyre::Result<()> {
        eyre::ensure!(boot != 0, "sensor board unavailable");
        eyre::ensure!(storage.record.pending.is_none(), "command outcome unknown");
        eyre::ensure!(self.request.is_none(), "request pending");
        let id = storage.record.next_command.get();
        let next_id = id
            .checked_add(1)
            .ok_or_else(|| eyre::eyre!("command IDs exhausted"))?;
        let command = Command {
            target_stm_boot: L4::new(boot),
            client_epoch: storage.record.client_epoch,
            command_id: L4::new(id),
            operation,
            expected_generation: L4::new(generation),
            data,
        };
        let mut next = storage.record.clone();
        next.next_command = L4::new(next_id);
        if matches!(operation, 1 | 2 | 4 | 5) {
            next.pending = Some(command.clone());
        }
        storage.save(next)?;
        self.request = Some(command.clone());
        if operation == 0 {
            self.reading = Some((id, self.stm.is_some()));
        }
        tx.try_send(Message::Command(command))
            .map_err(|_| eyre::eyre!("command queued; status unknown"))?;
        self.last_send = Instant::now();
        Ok(())
    }
    fn line(
        &mut self,
        line: &str,
        storage: &mut Storage,
        boot: u32,
        tx: &flume::Sender<Message>,
    ) -> eyre::Result<()> {
        if let Some(deadline) = self.secret_until.take() {
            eyre::ensure!(Instant::now() <= deadline, "secret entry expired");
            let mut bytes = from_hex::<32>(line)
                .filter(|b| b.len() == 32 && b.iter().any(|v| *v != 0))
                .ok_or_else(|| eyre::eyre!("invalid key"))?;
            self.stm
                .as_mut()
                .ok_or_else(|| eyre::eyre!("no STM draft"))?
                .key = Some(bytes.as_slice().try_into().unwrap());
            bytes.fill(0);
            reply!("{{\"ok\":true,\"staged\":true,\"group_key\":\"<redacted>\"}}");
            return Ok(());
        }
        let args: Vec<&str> = line.split_whitespace().collect();
        match args.as_slice() {
            ["status"]=>reply!("{{\"ok\":true,\"sparkle_boot\":{},\"stm_boot\":{},\"generation\":{},\"storage_fault\":{},\"pending\":{}}}",storage.record.boot.get(),boot,storage.record.settings.generation.get(),storage.fault,storage.record.pending.is_some()),
            ["config","get","sparkle"]=>{let bytes=provisioning::encode_record(&storage.record.settings).map_err(|_|eyre::eyre!("record"))?;reply!("{{\"ok\":true,\"owner\":\"sparkle\",\"generation\":{},\"record_hex\":\"{}\"}}",storage.record.settings.generation.get(),hex(&bytes));}
            ["config","begin","sparkle"]=>{eyre::ensure!(storage.record.pending.is_none()&&self.reading.is_none(),"pending transaction");self.stm=None;self.sparkle=Some(storage.record.settings.clone());reply!("{{\"ok\":true,\"owner\":\"sparkle\",\"base_generation\":{}}}",storage.record.settings.generation.get());}
            ["config","begin","stm"]=>{eyre::ensure!(storage.record.pending.is_none()&&self.reading.is_none(),"pending transaction");self.sparkle=None;self.stm=Some(default_stm());self.command(storage,boot,0,0,heapless::Vec::new(),tx)?;}
            ["config","get","stm"]=>{eyre::ensure!(self.reading.is_none(),"read pending");self.command(storage,boot,0,0,heapless::Vec::new(),tx)?;}
            ["config","set",key,value]=>{
                let valid=if let Some(s)=self.sparkle.as_mut(){s.set_value(key,value)}else if let Some(s)=self.stm.as_mut().filter(|_|self.reading.is_none()){set_stm(s,key,value)}else{false};
                eyre::ensure!(valid,"invalid setting");reply!("{{\"ok\":true,\"staged\":true}}");
            }
            ["config","secret","group_key"]=>{eyre::ensure!(self.stm.is_some()&&self.reading.is_none(),"no STM draft");self.secret_until=Some(Instant::now()+Duration::from_secs(60));reply!("{{\"ok\":true,\"secret\":true}}");}
            ["config","validate"]=>{
                let valid=if let Some(s)=&self.sparkle{let mut s=s.clone();s.generation=L4::new(s.generation.get().checked_add(1).unwrap_or(0));s.valid()}
                    else if let Some(s)=&self.stm{s.valid_common()&&s.key.is_none_or(|k|k!=[0;32])&&self.reading.is_none()}else{false};
                eyre::ensure!(valid,"invalid settings or missing required values");reply!("{{\"ok\":true}}");
            }
            ["config","commit"]=>{
                if let Some(s)=self.sparkle.as_ref(){storage.settings(s.clone())?;self.sparkle=None;reply!("{{\"ok\":true,\"state\":\"Applied\",\"generation\":{}}}",storage.record.settings.generation.get());}
                else if let Some(s)=self.stm.as_ref(){eyre::ensure!(self.reading.is_none()&&s.valid_common(),"invalid STM draft");let bytes=provisioning::encode_record(s).map_err(|_|eyre::eyre!("record"))?;self.command(storage,boot,1,self.stm_generation,bytes,tx)?;self.stm=None;}
                else{eyre::bail!("no draft");}
            }
            ["config","abort"]=>{self.sparkle=None;self.stm=None;self.secret_until=None;reply!("{{\"ok\":true}}");}
            ["mode",value]|["brightness",value]|["range",value]|["blank",value]|["pattern",value]|["peer",value]=>{
                let key=match args[0]{"mode"=>"ui.mode","brightness"=>"ui.brightness_percent","range"=>"ui.map_range_m","blank"=>"ui.blanked","pattern"=>"pattern.preset",_=>"ui.selected_peer_id"};
                let mut s=storage.record.settings.clone();eyre::ensure!(s.set_value(key,value),"invalid UI value");storage.settings(s)?;reply!("{{\"ok\":true,\"state\":\"Applied\",\"generation\":{}}}",storage.record.settings.generation.get());
            }
            ["key","check",nonce]=>{let data=from_hex::<384>(nonce).filter(|v|v.len()==16).ok_or_else(||eyre::eyre!("invalid nonce"))?;self.command(storage,boot,7,0,data,tx)?;}
            ["gps","diagnostics"]=>self.command(storage,boot,8,0,heapless::Vec::new(),tx)?,
            ["calibration","begin"]=>self.command(storage,boot,2,0,heapless::Vec::from_slice(&[0]).unwrap(),tx)?,
            ["calibration","cancel",run]=>{let data=from_hex::<384>(run).filter(|v|v.len()==8).ok_or_else(||eyre::eyre!("invalid run"))?;self.command(storage,boot,3,0,data,tx)?;}
            ["calibration","stream",run,enabled]=>{let mut data=from_hex::<384>(run).filter(|v|v.len()==8).ok_or_else(||eyre::eyre!("invalid run"))?;data.push(match *enabled{"on"=>1,"off"=>0,_=>eyre::bail!("invalid stream state")}).unwrap();self.command(storage,boot,9,0,data,tx)?;}
            ["calibration","stage",run,record]=>{let mut data=from_hex::<384>(run).filter(|v|v.len()==8).ok_or_else(||eyre::eyre!("invalid run"))?;let record=from_hex::<384>(record).filter(|v|v.len()==120).ok_or_else(||eyre::eyre!("invalid coefficient record"))?;data.extend_from_slice(&record).unwrap();self.command(storage,boot,4,0,data,tx)?;}
            ["calibration","save",run,digest]=>{let mut data=from_hex::<384>(run).filter(|v|v.len()==8).ok_or_else(||eyre::eyre!("invalid run"))?;let digest=from_hex::<384>(digest).filter(|v|v.len()==32).ok_or_else(||eyre::eyre!("invalid digest"))?;data.extend_from_slice(&digest).unwrap();self.command(storage,boot,5,self.stm_generation,data,tx)?;}
            ["calibration","preview",run]=>{let data=from_hex::<384>(run).filter(|v|v.len()==8).ok_or_else(||eyre::eyre!("invalid run"))?;self.command(storage,boot,10,0,data,tx)?;}
            ["calibration","load",run,load]=>{
                let id=from_hex::<8>(run).filter(|v|v.len()==8).ok_or_else(||eyre::eyre!("invalid run"))?;
                let state=self.calibration.as_mut().filter(|(active,preview,_,at)|active.as_slice()==id.as_slice()&&*preview&&at.elapsed()<Duration::from_secs(30)).ok_or_else(||eyre::eyre!("no confirmed preview"))?;
                state.2=match *load{"white"=>true,"off"=>false,_=>eyre::bail!("invalid load")};
                reply!("{{\"ok\":true,\"temporary\":true}}");
            }
            ["command","status"]=>{if let Some(pending)=storage.record.pending.clone(){let mut data=heapless::Vec::new();data.extend_from_slice(&pending.client_epoch.0).unwrap();data.extend_from_slice(&pending.command_id.0).unwrap();
                let id=storage.record.next_command.get();let mut next=storage.record.clone();next.next_command=L4::new(id.checked_add(1).ok_or_else(||eyre::eyre!("command exhaustion"))?);storage.save(next)?;
                let command=Command{target_stm_boot:L4::new(boot),client_epoch:storage.record.client_epoch,command_id:L4::new(id),operation:6,expected_generation:L4::new(0),data};
                self.request=Some(command.clone());self.last_send=Instant::now();
                tx.try_send(Message::Command(command)).map_err(|_|eyre::eyre!("board unavailable"))?;
            }else{reply!("{{\"ok\":true,\"pending\":false}}");}}
            _=>eyre::bail!("unknown command"),
        }
        Ok(())
    }
    fn result(&mut self, storage: &mut Storage, result: CommandResult) -> eyre::Result<()> {
        if result.client_epoch != storage.record.client_epoch {
            return Ok(());
        }
        let request = self
            .request
            .as_ref()
            .filter(|c| c.command_id == result.command_id)
            .or_else(|| {
                storage
                    .record
                    .pending
                    .as_ref()
                    .filter(|c| c.command_id == result.command_id)
            })
            .cloned();
        let Some(request) = request else {
            return Ok(());
        };
        if self
            .request
            .as_ref()
            .is_some_and(|c| c.command_id == result.command_id)
        {
            self.request = None;
        }
        if request.operation == 6 && result.status == 0 && result.data.len() == 37 {
            if let Some(pending) = storage.record.pending.clone().filter(|p| {
                request.data.as_slice() == [p.client_epoch.0, p.command_id.0].concat().as_slice()
            }) {
                let mut data = heapless::Vec::new();
                let status = result.data[0];
                if status == 0 {
                    if pending.operation == 2 {
                        data.extend_from_slice(&pending.client_epoch.0).unwrap();
                        data.extend_from_slice(&pending.command_id.0).unwrap();
                    } else if matches!(pending.operation, 1 | 5) {
                        data.extend_from_slice(&result.data[5..]).unwrap();
                    }
                }
                return self.result(
                    storage,
                    CommandResult {
                        stm_boot: result.stm_boot,
                        client_epoch: pending.client_epoch,
                        command_id: pending.command_id,
                        status: if status == 0 { 1 } else { status },
                        result_generation: L4(result.data[1..5].try_into().unwrap()),
                        data,
                    },
                );
            }
        }
        if result.status <= 1 {
            match request.operation {
                2 if result.data.len() == 8 => {
                    self.calibration = Some((
                        result.data[..].try_into().unwrap(),
                        false,
                        false,
                        Instant::now(),
                    ))
                }
                3 | 5 => self.calibration = None,
                4 | 9 if request.data.len() >= 8 => {
                    if let Some(state) = self
                        .calibration
                        .as_mut()
                        .filter(|(id, _, _, _)| id.as_slice() == &request.data[..8])
                    {
                        state.1 |= request.operation == 4;
                        state.3 = Instant::now();
                    }
                }
                _ => {}
            }
        }
        if let Some((id, begin)) = self
            .reading
            .filter(|(id, _)| *id == result.command_id.get())
        {
            let _ = id;
            self.reading = None;
            if result.status == 0 {
                let public: StmRecord<u8> = provisioning::decode_record(&result.data)
                    .map_err(|_| eyre::eyre!("invalid board readback"))?;
                self.stm_generation = public.generation.get();
                if begin {
                    let mut draft = public.map_key(None);
                    draft.generation = L4::new(
                        self.stm_generation
                            .checked_add(1)
                            .ok_or_else(|| eyre::eyre!("generation exhaustion"))?,
                    );
                    self.stm = Some(draft);
                    reply!(
                        "{{\"ok\":true,\"owner\":\"stm\",\"base_generation\":{}}}",
                        self.stm_generation
                    );
                } else {
                    reply!(
                        "{{\"ok\":true,\"owner\":\"stm\",\"generation\":{},\"record_hex\":\"{}\"}}",
                        self.stm_generation,
                        hex(&result.data)
                    );
                }
            } else if result.status == 8 && begin {
                self.stm_generation = 0;
                self.stm = Some(default_stm());
                reply!("{{\"ok\":true,\"owner\":\"stm\",\"base_generation\":0}}");
            } else {
                reply!("{{\"ok\":false,\"status\":{}}}", result.status);
            }
            return Ok(());
        }
        if storage.record.pending.as_ref().is_some_and(|p| {
            p.command_id == result.command_id && p.client_epoch == result.client_epoch
        }) && matches!(result.status, 0 | 1 | 2 | 3 | 5 | 8)
        {
            let mut next = storage.record.clone();
            next.pending = None;
            storage.save(next)?;
            self.stm_generation = result.result_generation.get();
        }
        reply!(
            "{{\"ok\":{},\"status\":{},\"generation\":{},\"data_hex\":\"{}\"}}",
            result.status <= 1,
            result.status,
            result.result_generation.get(),
            hex(&result.data)
        );
        Ok(())
    }
}

pub fn run() -> eyre::Result<()> {
    sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();
    let (output, printing) = flume::bounded::<String>(8);
    CONSOLE_OUTPUT
        .set(output)
        .map_err(|_| eyre::eyre!("console already running"))?;
    thread::Builder::new()
        .name("amulet-console-output".into())
        .stack_size(8192)
        .spawn(move || {
            while let Ok(line) = printing.recv() {
                let dropped = CONSOLE_DROPS.swap(0, Ordering::Relaxed);
                if dropped != 0 {
                    std::println!("{{\"event\":\"console_overflow\",\"dropped\":{dropped}}}");
                }
                std::println!("{line}");
            }
        })?;
    let peripherals = Peripherals::take()?;
    let pins = peripherals.pins;
    let mut storage = Storage::open()?;
    let mut console = Console::new();
    let (commands, lines) = flume::bounded::<Vec<u8>>(8);
    thread::Builder::new()
        .name("amulet-console".into())
        .stack_size(8192)
        .spawn(move || {
            let mut input = std::io::stdin();
            let mut line = Vec::with_capacity(1024);
            let mut byte = [0];
            let mut discarding = false;
            while input.read_exact(&mut byte).is_ok() {
                if byte[0] == b'\n' {
                    if !discarding {
                        let _ =
                            commands.send(core::mem::replace(&mut line, Vec::with_capacity(1024)));
                    }
                    line.fill(0);
                    line.clear();
                    discarding = false;
                } else if byte[0] != b'\r' && !discarding {
                    if line.len() < 1024 {
                        line.push(byte[0]);
                    } else {
                        line.fill(0);
                        line.clear();
                        discarding = true;
                    }
                }
            }
        })?;
    let (outgoing, transmit) = flume::bounded::<Message>(4);
    let uart = UartDriver::new(
        peripherals.uart1,
        pins.gpio9,
        pins.gpio10,
        None::<esp_idf_svc::hal::gpio::AnyIOPin>,
        None::<esp_idf_svc::hal::gpio::AnyIOPin>,
        &Config::default().baudrate(Hertz(MESSAGE_BAUD_RATE)),
    )?;
    let (mut tx, rx) = uart.into_split();
    thread::Builder::new()
        .name("amulet-board-tx".into())
        .stack_size(8192)
        .spawn(move || {
            let mut encoder = MessageEncoder::new();
            while let Ok(message) = transmit.recv() {
                if let Ok(frame) = encoder.encode(&message) {
                    let mut offset = 0;
                    while offset < frame.len() {
                        match tx.write(&frame[offset..]) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => offset += n,
                        }
                    }
                }
            }
        })?;
    let enabled = Arc::new(AtomicBool::new(false));
    let audio = Arc::new(Mutex::new(Audio::default()));
    let mic_enabled = enabled.clone();
    let mic_audio = audio.clone();
    thread::Builder::new()
        .name("amulet-microphone".into())
        .stack_size(32768)
        .spawn(move || {
            microphone(
                peripherals.i2s0,
                pins.gpio26,
                pins.gpio33,
                pins.gpio25,
                mic_enabled,
                mic_audio,
            )
        })?;
    let mut circle = Pixels::new(pins.gpio21)?;
    let mut halo = Pixels::new(pins.gpio23)?;
    let mut inner = Pixels::new(pins.gpio22)?;
    let mut outer = Pixels::new(pins.gpio19)?;
    let profiles = core::array::from_fn(|_| LedResponse::default()); // Four separately unmeasured installed profiles.
    let mut renderer = Renderer::default();
    let mut linear: Box<[LinSrgb; PIXELS]> = vec![LinSrgb::new(0.0, 0.0, 0.0); PIXELS]
        .into_boxed_slice()
        .try_into()
        .expect("fixed pixel count");
    let mut pixels: Box<[RGB8; PIXELS]> = vec![RGB8::default(); PIXELS]
        .into_boxed_slice()
        .try_into()
        .expect("fixed pixel count");
    let mut decoder = MessageDecoder::new();
    let mut input = [0; 512];
    let started = Instant::now();
    let mut snapshot: Option<(StateSnapshot, u64)> = None;
    let mut stm_boot = 0;
    let mut hello_at = Instant::now() - Duration::from_secs(2);
    loop {
        let tick = Instant::now();
        let now = started.elapsed().as_millis() as u64;
        if let Ok(count) = rx.read(&mut input, 0) {
            for &byte in &input[..count] {
                if let Some(Ok(message)) = decoder.feed(byte) {
                    match message {
                        Message::Hello(hello) if hello.role == 0 => {
                            if hello.boot.get() != stm_boot {
                                stm_boot = hello.boot.get();
                                snapshot = None;
                                console.calibration = None;
                                console.request = None;
                                console.reading = None;
                            }
                            console.stm_generation = hello.settings_generation.get();
                        }
                        Message::StateSnapshot(next) => {
                            let newer = snapshot.as_ref().is_none_or(|(old, _)| {
                                next.boot == old.boot && next.sequence.get() > old.sequence.get()
                            });
                            if next.boot.get() == stm_boot && newer {
                                snapshot = Some((next, now));
                            }
                        }
                        Message::CommandResult(result) if result.stm_boot.get() == stm_boot => {
                            if console.result(&mut storage, result).is_err() {
                                reply!("{{\"ok\":false,\"error\":\"StorageFault\"}}");
                            }
                        }
                        Message::CalibrationBatch(batch) => {
                            let mut encoder = MessageEncoder::new();
                            if let Ok(frame) = encoder.encode(&Message::CalibrationBatch(batch)) {
                                reply!(
                                    "{{\"event\":\"calibration\",\"wire\":\"{}\"}}",
                                    STANDARD.encode(frame)
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        if hello_at.elapsed() >= Duration::from_secs(1) {
            let _ = outgoing.try_send(Message::Hello(Hello {
                role: 1,
                boot: storage.record.boot,
                firmware: firmware_id(),
                capabilities: L2::new(0x29),
                settings_generation: storage.record.settings.generation,
            }));
            hello_at = Instant::now();
        }
        if let Some(pending) = &storage.record.pending {
            if stm_boot != 0 && console.last_send.elapsed() >= Duration::from_secs(1) {
                let mut command = pending.clone();
                command.target_stm_boot = L4::new(stm_boot);
                let _ = outgoing.try_send(Message::Command(command));
                console.last_send = Instant::now();
            }
        }
        if console.last_send.elapsed() > Duration::from_secs(6) && storage.record.pending.is_none()
        {
            console.request = None;
            console.reading = None;
        }
        if console
            .calibration
            .is_some_and(|(_, _, _, at)| at.elapsed() >= Duration::from_secs(30))
        {
            console.calibration = None;
        }
        if let Ok(mut line) = lines.try_recv() {
            let valid = std::str::from_utf8(&line).ok().is_some_and(|line| {
                console
                    .line(line.trim(), &mut storage, stm_boot, &outgoing)
                    .is_ok()
            });
            line.fill(0);
            if !valid {
                reply!(
                    "{{\"ok\":false,\"error\":\"Rejected; check status and required settings\"}}"
                );
            }
        }
        let settings = &storage.record.settings;
        enabled.store(
            settings.valid() && settings.mode == 2 && settings.preset == 4 && !settings.blanked,
            Ordering::Relaxed,
        );
        let audio = audio.lock().unwrap();
        renderer.render(
            settings,
            snapshot.as_ref().map(|(s, at)| (s, *at)),
            now,
            audio.level,
            audio.fault,
            &mut linear,
        );
        drop(audio);
        let connected = snapshot
            .as_ref()
            .is_some_and(|(_, at)| now.saturating_sub(*at) <= 2000);
        if connected {
            let preview = console
                .calibration
                .is_some_and(|(_, preview, _, _)| preview);
            let collecting = snapshot.as_ref().is_some_and(|(s, _)| {
                s.health.get() & musical_lights_core::radio::CALIBRATING != 0
            }) && !preview;
            let white = console
                .calibration
                .is_some_and(|(_, preview, white, _)| preview && white);
            musical_lights_core::amulet::calibration_frame(
                settings,
                collecting,
                white,
                &mut linear,
            );
        }
        amulet_output::encode(settings, &profiles, &linear, &mut pixels);
        for result in [
            circle.write(pixels[..256].iter().copied()),
            halo.write(pixels[256..320].iter().copied()),
            inner.write(pixels[320..404].iter().copied()),
            outer.write(pixels[404..].iter().copied()),
        ] {
            if result.is_err() {
                reply!("log: LED output unavailable");
            }
        }
        thread::sleep(Duration::from_millis(20).saturating_sub(tick.elapsed()));
    }
}

fn firmware_id() -> [u8; 8] {
    let revision = env!("FIRMWARE_REVISION");
    core::array::from_fn(|i| {
        u8::from_str_radix(&revision[i * 2..i * 2 + 2], 16).expect("hex source revision")
    })
}
