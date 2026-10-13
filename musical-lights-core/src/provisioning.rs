//! Canonical wired settings. No positions, button fields or pairing operations.
use crate::{
    message::{L2, L4, L8},
    radio::{Identity, Roster},
    storage::{Checkpoint, Outcome, StorageError},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
const CRC: crc::Crc<u32> = crc::Crc::<u32>::new(&crc::CRC_32_ISO_HDLC);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct F4(pub [u8; 4]);
impl F4 {
    pub fn get(self) -> f32 {
        f32::from_le_bytes(self.0)
    }
    pub fn new(value: f32) -> Self {
        Self(value.to_le_bytes())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coefficients {
    pub schema: L2,
    pub sensor_profile: L2,
    pub mount_revision: L4,
    pub revision: L4,
    pub mag_samples: L4,
    pub temperature: L2,
    pub accel_bias: [F4; 3],
    pub accel_scale: [F4; 3],
    pub gyro_bias: [F4; 3],
    pub mag_bias: [F4; 3],
    pub mag_matrix: [F4; 9],
    pub field: F4,
    pub holdout_rms: F4,
    pub holdout_max: F4,
    pub solver: L2,
    pub crc: L4,
}
impl Coefficients {
    pub fn valid(&self, profile: u16, mount: u32) -> bool {
        let mut bytes = [0; 120];
        if postcard::to_slice(self, &mut bytes).is_err()
            || CRC.checksum(&bytes[..116]) != self.crc.get()
            || self.schema.get() != 1
            || self.sensor_profile.get() != profile
            || self.mount_revision.get() != mount
            || self.revision.get() == 0
            || self.mag_samples.get() < 360
            || self.solver.get() != 1
        {
            return false;
        }
        let all = self
            .accel_bias
            .iter()
            .chain(&self.accel_scale)
            .chain(&self.gyro_bias)
            .chain(&self.mag_bias)
            .chain(&self.mag_matrix)
            .chain([&self.field, &self.holdout_rms, &self.holdout_max]);
        if !all.into_iter().all(|v| v.get().is_finite())
            || !(15.0..=80.0).contains(&self.field.get())
            || !(0.0..=self.field.get() * 0.05).contains(&self.holdout_rms.get())
            || !(0.0..=self.field.get() * 0.15).contains(&self.holdout_max.get())
            || !self
                .accel_scale
                .iter()
                .all(|v| (0.5..=2.0).contains(&v.get()))
        {
            return false;
        }
        let m = self.mag_matrix.map(|v| v.get() as f64);
        if (m[1] - m[3]).abs() > 1e-6 || (m[2] - m[6]).abs() > 1e-6 || (m[5] - m[7]).abs() > 1e-6 {
            return false;
        }
        let matrix = nalgebra::Matrix3::from_row_slice(&m);
        let eigen = nalgebra::linalg::SymmetricEigen::new(matrix).eigenvalues;
        let low = eigen.iter().copied().fold(f64::INFINITY, f64::min);
        let high = eigen.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        low > 0.0 && high / low <= 4.0
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RosterEntry {
    pub id: L2,
    pub color: u8,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StmRecord<K> {
    pub schema: L2,
    pub generation: L4,
    pub device_id: L2,
    pub group_id: L4,
    pub key_id: L4,
    pub key: K,
    pub roster_revision: L4,
    pub roster: heapless::Vec<RosterEntry, 8>,
    pub radio_profile: L2,
    pub interval_ms: L4,
    pub relay_enabled: bool,
    pub sensor_profile: L2,
    pub mount_revision: L4,
    pub gps_profile: L2,
    pub battery_profile: L2,
    pub calibration: Option<Coefficients>,
}
impl<K> StmRecord<K> {
    pub fn map_key<T>(self, key: T) -> StmRecord<T> {
        StmRecord {
            schema: self.schema,
            generation: self.generation,
            device_id: self.device_id,
            group_id: self.group_id,
            key_id: self.key_id,
            key,
            roster_revision: self.roster_revision,
            roster: self.roster,
            radio_profile: self.radio_profile,
            interval_ms: self.interval_ms,
            relay_enabled: self.relay_enabled,
            sensor_profile: self.sensor_profile,
            mount_revision: self.mount_revision,
            gps_profile: self.gps_profile,
            battery_profile: self.battery_profile,
            calibration: self.calibration,
        }
    }
    pub fn network_roster(&self) -> Roster {
        Roster {
            revision: self.roster_revision.get(),
            peers: self
                .roster
                .iter()
                .map(|p| Identity {
                    id: p.id.get(),
                    color: p.color,
                })
                .collect(),
        }
    }
}
impl<K> StmRecord<K> {
    pub fn valid_common(&self) -> bool {
        self.schema.get() == 1
            && self.generation.get() != 0
            && self.group_id.get() != 0
            && self.key_id.get() != 0
            && self.network_roster().validate(self.device_id.get())
            && self.radio_profile.get() == 1
            && (5000..=60000).contains(&self.interval_ms.get())
            && self.sensor_profile.get() == 1
            && self.mount_revision.get() != 0
            && self.gps_profile.get() == 1
            && self.battery_profile.get() == 0
            && self
                .calibration
                .as_ref()
                .is_none_or(|c| c.valid(self.sensor_profile.get(), self.mount_revision.get()))
    }
}
impl StmRecord<[u8; 32]> {
    pub fn valid(&self) -> bool {
        self.valid_common() && self.key != [0; 32]
    }
    pub fn public_bytes(&self) -> Result<heapless::Vec<u8, 384>, StorageError> {
        encode_record(&self.clone().map_key(1u8))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SparkleRecord {
    pub schema: L2,
    pub generation: L4,
    pub display_profile: L2,
    pub rotation: L2,
    pub halo_clockwise: bool,
    pub inner_clockwise: bool,
    pub outer_clockwise: bool,
    pub total_ma: L2,
    pub reserve_ma: L2,
    pub circle_ma: L2,
    pub halo_ma: L2,
    pub inner_ma: L2,
    pub outer_ma: L2,
    pub circle_cap: u8,
    pub halo_cap: u8,
    pub inner_cap: u8,
    pub outer_cap: u8,
    pub mode: u8,
    pub blanked: bool,
    pub brightness: u8,
    pub range: u8,
    pub orientation: u8,
    pub selected: Option<L2>,
    pub preset: u8,
    pub cycle_ms: L4,
    pub time_origin: L8,
    pub circle_response: L2,
    pub halo_response: L2,
    pub inner_response: L2,
    pub outer_response: L2,
    pub audio_profile: L2,
}
impl Default for SparkleRecord {
    fn default() -> Self {
        Self {
            schema: L2::new(1),
            generation: L4::new(0),
            display_profile: L2::new(1),
            rotation: L2::new(0),
            halo_clockwise: true,
            inner_clockwise: true,
            outer_clockwise: true,
            total_ma: L2::new(0),
            reserve_ma: L2::new(0),
            circle_ma: L2::new(0),
            halo_ma: L2::new(0),
            inner_ma: L2::new(0),
            outer_ma: L2::new(0),
            circle_cap: 128,
            halo_cap: 128,
            inner_cap: 128,
            outer_cap: 128,
            mode: 0,
            blanked: false,
            brightness: 25,
            range: 2,
            orientation: 0,
            selected: None,
            preset: 0,
            cycle_ms: L4::new(8000),
            time_origin: L8::new(0),
            circle_response: L2::new(1),
            halo_response: L2::new(1),
            inner_response: L2::new(1),
            outer_response: L2::new(1),
            audio_profile: L2::new(1),
        }
    }
}
impl SparkleRecord {
    pub fn valid(&self) -> bool {
        let branches = [self.circle_ma, self.halo_ma, self.inner_ma, self.outer_ma];
        self.schema.get() == 1
            && self.generation.get() != 0
            && self.display_profile.get() == 1
            && self.rotation.get() < 36000
            && (1..=5000).contains(&self.total_ma.get())
            && self.reserve_ma.get() > 0
            && branches
                .iter()
                .zip(crate::amulet::COUNTS)
                .all(|(b, count)| b.get() as usize >= count)
            && branches.iter().map(|b| b.get() as u32).sum::<u32>() + self.reserve_ma.get() as u32
                <= self.total_ma.get() as u32
            && [
                self.circle_cap,
                self.halo_cap,
                self.inner_cap,
                self.outer_cap,
            ]
            .iter()
            .all(|v| *v > 0)
            && self.mode <= 2
            && [5, 10, 25, 50, 100].contains(&self.brightness)
            && self.range <= 5
            && self.orientation <= 1
            && self
                .selected
                .is_none_or(|p| p.get() != 0 && p.get() != u16::MAX)
            && self.preset <= 4
            && (2000..=60000).contains(&self.cycle_ms.get())
            && self.time_origin.get() == 0
            && [
                self.circle_response,
                self.halo_response,
                self.inner_response,
                self.outer_response,
                self.audio_profile,
            ]
            .iter()
            .all(|p| p.get() == 1)
    }
}

pub fn encode_record<T: Serialize>(record: &T) -> Result<heapless::Vec<u8, 384>, StorageError> {
    let mut buffer = [0; 384];
    let length = postcard::to_slice(record, &mut buffer[..380])
        .map_err(|_| StorageError::TooLarge)?
        .len();
    let crc = CRC.checksum(&buffer[..length]);
    buffer[length..length + 4].copy_from_slice(&crc.to_le_bytes());
    heapless::Vec::from_slice(&buffer[..length + 4]).map_err(|_| StorageError::TooLarge)
}
pub fn decode_record<'a, T: Deserialize<'a> + Serialize>(
    bytes: &'a [u8],
) -> Result<T, StorageError> {
    let n = bytes.len().checked_sub(4).ok_or(StorageError::Corrupt)?;
    if CRC.checksum(&bytes[..n]) != u32::from_le_bytes(bytes[n..].try_into().unwrap()) {
        return Err(StorageError::Corrupt);
    }
    let (value, rest) =
        postcard::take_from_bytes(&bytes[..n]).map_err(|_| StorageError::Corrupt)?;
    if !rest.is_empty() || encode_record(&value)?.as_slice() != bytes {
        return Err(StorageError::Corrupt);
    }
    Ok(value)
}
pub fn public_digest(owner: u8, bytes: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"SC-PUBLIC-V1\0");
    hash.update([owner]);
    hash.update(bytes);
    hash.finalize().into()
}
pub fn request_digest(command: &crate::message::Command) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"SC-REQUEST-V1\0");
    hash.update(command.client_epoch.0);
    hash.update(command.command_id.0);
    hash.update([command.operation]);
    hash.update(command.expected_generation.0);
    let mut data = [0; 386];
    let encoded = postcard::to_slice(&command.data, &mut data).expect("bounded command data");
    hash.update(encoded);
    hash.finalize().into()
}
pub fn completion(
    checkpoint: &mut Checkpoint,
    command: &crate::message::Command,
    status: u8,
    generation: u32,
    digest: [u8; 32],
) -> Result<(), StorageError> {
    checkpoint.record(Outcome {
        client_epoch: command.client_epoch,
        command_id: command.command_id,
        operation: command.operation,
        status,
        originating_boot: checkpoint.boot,
        generation: L4::new(generation),
        request_digest: request_digest(command),
        public_digest: digest,
    })
}

impl SparkleRecord {
    pub fn set_value(&mut self, key: &str, value: &str) -> bool {
        let settings = self;

        let number = value.parse::<u16>().ok();
        match key {
            "ui.mode" => {
                settings.mode = match value {
                    "Map" => 0,
                    "Compass" => 1,
                    "Patterns" => 2,
                    _ => return false,
                }
            }
            "ui.blanked" => {
                settings.blanked = match value {
                    "true" => true,
                    "false" => false,
                    _ => return false,
                }
            }
            "ui.brightness_percent" => {
                if let Some(v) = number.filter(|v| [5, 10, 25, 50, 100].contains(v)) {
                    settings.brightness = v as u8;
                } else {
                    return false;
                }
            }
            "ui.map_range_m" => {
                if let Some(i) = [100, 250, 500, 1000, 2000, 5000]
                    .iter()
                    .position(|v| Some(*v) == number)
                {
                    settings.range = i as u8;
                } else {
                    return false;
                }
            }
            "ui.map_orientation" => {
                settings.orientation = match value {
                    "HeadingUp" => 0,
                    "NorthUp" => 1,
                    _ => return false,
                }
            }
            "ui.selected_peer_id" => {
                settings.selected = if value == "none" {
                    None
                } else if let Some(id) = number.filter(|v| *v != 0 && *v != u16::MAX) {
                    Some(L2::new(id))
                } else {
                    return false;
                }
            }
            "pattern.preset" => {
                if let Some(v) = number.filter(|v| *v <= 4) {
                    settings.preset = v as u8;
                } else {
                    return false;
                }
            }
            "pattern.cycle_ms" => {
                if let Some(v) = number.filter(|v| (2000..=60000).contains(v)) {
                    settings.cycle_ms = L4::new(v as u32);
                } else {
                    return false;
                }
            }
            "power.total_mA" => {
                if let Some(v) = number {
                    settings.total_ma = L2::new(v);
                } else {
                    return false;
                }
            }
            "power.reserve_mA" => {
                if let Some(v) = number {
                    settings.reserve_ma = L2::new(v);
                } else {
                    return false;
                }
            }
            "power.circle_mA" => {
                if let Some(v) = number {
                    settings.circle_ma = L2::new(v);
                } else {
                    return false;
                }
            }
            "power.halo_mA" => {
                if let Some(v) = number {
                    settings.halo_ma = L2::new(v);
                } else {
                    return false;
                }
            }
            "power.inner_ring_mA" => {
                if let Some(v) = number {
                    settings.inner_ma = L2::new(v);
                } else {
                    return false;
                }
            }
            "power.outer_ring_mA" => {
                if let Some(v) = number {
                    settings.outer_ma = L2::new(v);
                } else {
                    return false;
                }
            }
            _ => return false,
        }
        true
    }
}
