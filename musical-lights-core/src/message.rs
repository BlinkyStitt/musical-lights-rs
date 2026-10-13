//! One board schema: Postcard, CRC-16/IBM-SDLC, COBS and a zero delimiter.
use crate::errors::{MyError, MyResult};
use serde::{Deserialize, Serialize};
pub const MESSAGE_BAUD_RATE: u32 = 115200;
macro_rules! little {
    ($name:ident, $type:ty, $size:expr) => {
        #[cfg_attr(feature = "defmt", derive(defmt::Format))]
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
        pub struct $name(pub [u8; $size]);
        impl $name {
            pub const fn new(value: $type) -> Self {
                Self(value.to_le_bytes())
            }
            pub const fn get(self) -> $type {
                <$type>::from_le_bytes(self.0)
            }
        }
    };
}
little!(L2, u16, 2);
little!(L4, u32, 4);
little!(L8, u64, 8);
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub lat: L4,
    pub lon: L4,
    pub age: L4,
    pub accuracy: L2,
    pub flags: L2,
}
impl Position {
    pub fn valid(&self) -> bool {
        let flags = self.flags.get();
        flags & !7 == 0
            && (flags & 1 != 0
                || (flags == 0
                    && self.lat.get() == 0
                    && self.lon.get() == 0
                    && self.age.get() == 0
                    && self.accuracy.get() == 0))
            && (flags & 1 == 0
                || ((-900000000..=900000000).contains(&(self.lat.get() as i32))
                    && (-1800000000..=1800000000).contains(&(self.lon.get() as i32))))
            && (flags & 1 == 0
                || if flags & 4 != 0 {
                    (1..u16::MAX).contains(&self.accuracy.get())
                } else {
                    self.accuracy.get() == u16::MAX
                })
    }
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heading {
    pub magnetic: L2,
    pub true_north: L2,
    pub age: L2,
    pub quality: u8,
    pub faults: L2,
    pub tilt: L2,
    pub calibration_revision: L4,
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clock {
    pub state: u8,
    pub utc_anchor: L8,
    pub anchor_age: L4,
    pub uncertainty: L4,
}
impl Default for Clock {
    fn default() -> Self {
        Self {
            state: 0,
            utc_anchor: L8::new(0),
            anchor_age: L4::new(u32::MAX),
            uncertainty: L4::new(u32::MAX),
        }
    }
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Battery {
    pub state: u8,
    pub factor: L2,
    pub pack_mv: L2,
    pub soc: L2,
    pub age: L2,
    pub profile_revision: L4,
}
impl Default for Battery {
    fn default() -> Self {
        Self {
            state: 0,
            factor: L2::new(1000),
            pack_mv: L2::new(0),
            soc: L2::new(u16::MAX),
            age: L2::new(u16::MAX),
            profile_revision: L4::new(0),
        }
    }
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    pub id: L2,
    pub origin_boot: L4,
    pub sequence: L4,
    pub position: Position,
    pub health: L2,
    pub hop: u8,
    pub rssi: L2,
    pub snr: u8,
    pub color: u8,
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateSnapshot {
    pub boot: L4,
    pub sequence: L4,
    pub uptime: L4,
    pub settings_generation: L4,
    pub roster_revision: L4,
    pub local: Position,
    pub heading: Heading,
    pub clock: Clock,
    pub battery: Battery,
    pub health: L2,
    pub slot: u8,
    pub count: u8,
    pub peers: heapless::Vec<Peer, 7>,
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub role: u8,
    pub boot: L4,
    pub firmware: [u8; 8],
    pub capabilities: L2,
    pub settings_generation: L4,
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
    pub target_stm_boot: L4,
    pub client_epoch: L4,
    pub command_id: L4,
    pub operation: u8,
    pub expected_generation: L4,
    pub data: heapless::Vec<u8, 384>,
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    pub stm_boot: L4,
    pub client_epoch: L4,
    pub command_id: L4,
    pub status: u8,
    pub result_generation: L4,
    pub data: heapless::Vec<u8, 384>,
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heartbeat {
    pub role: u8,
    pub boot: L4,
    pub uptime: L4,
    pub health: L2,
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawSample {
    pub captured_at: L4,
    pub valid: u8,
    pub accel: [[u8; 4]; 3],
    pub gyro: [[u8; 4]; 3],
    pub mag: [[u8; 4]; 3],
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalibrationBatch {
    pub stm_boot: L4,
    pub run_id: [u8; 8],
    pub batch_sequence: L4,
    pub overrun_samples: L4,
    pub samples: heapless::Vec<RawSample, 8>,
}
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Message {
    Hello(Hello),
    StateSnapshot(StateSnapshot),
    Command(Command),
    CommandResult(CommandResult),
    Heartbeat(Heartbeat),
    CalibrationBatch(CalibrationBatch),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Envelope {
    version: u8,
    message: Message,
}
impl Message {
    pub fn valid(&self) -> bool {
        match self {
            Self::Hello(h) => h.role <= 1 && h.boot.get() != 0 && h.capabilities.get() & !0x2b == 0,
            Self::Heartbeat(h) => {
                h.role <= 1 && h.boot.get() != 0 && crate::radio::valid_health(h.health.get())
            }
            Self::Command(c) => {
                c.target_stm_boot.get() != 0
                    && c.client_epoch.get() != 0
                    && c.command_id.get() != 0
                    && c.operation <= 10
            }
            Self::CommandResult(c) => {
                c.stm_boot.get() != 0
                    && c.client_epoch.get() != 0
                    && c.command_id.get() != 0
                    && c.status <= 9
            }
            Self::StateSnapshot(s) => {
                s.boot.get() != 0
                    && s.sequence.get() != 0
                    && s.local.valid()
                    && s.local.flags.get() == s.health.get() & 7
                    && crate::radio::valid_health(s.health.get())
                    && s.heading.quality <= 7
                    && s.heading.faults.get() & !127 == 0
                    && s.heading.tilt.get() <= 9000
                    && (matches!(s.heading.quality, 3 | 4)
                        || (s.heading.magnetic.get() == 0 && s.heading.true_north.get() == 0))
                    && (s.heading.quality != 3 || s.heading.true_north.get() == 0)
                    && (!matches!(s.heading.quality, 3 | 4)
                        || s.heading.calibration_revision.get() != 0)
                    && s.heading.magnetic.get() < 36000
                    && s.heading.true_north.get() < 36000
                    && s.clock.state <= 3
                    && (if matches!(s.clock.state, 2 | 3) {
                        s.clock.utc_anchor.get() != 0
                            && s.clock.anchor_age.get() <= 1800000
                            && s.clock.uncertainty.get() as u64
                                + (s.clock.anchor_age.get() as u64).div_ceil(10000)
                                <= 250
                    } else {
                        s.clock.utc_anchor.get() == 0 && s.clock.uncertainty.get() == u32::MAX
                    })
                    && s.battery.state <= 4
                    && s.battery.factor.get() <= 1000
                    && ((s.count == 0 && s.slot == 255)
                        || ((1..=8).contains(&s.count)
                            && s.slot < s.count
                            && s.roster_revision.get() != 0))
                    && s.peers.windows(2).all(|p| p[0].id.get() < p[1].id.get())
                    && s.peers.iter().all(|p| {
                        p.position.valid()
                            && p.position.flags.get() == p.health.get() & 7
                            && crate::radio::valid_health(p.health.get())
                            && p.color < 8
                            && (1..=2).contains(&p.hop)
                    })
            }
            Self::CalibrationBatch(b) => {
                b.stm_boot.get() != 0
                    && b.batch_sequence.get() != 0
                    && !b.samples.is_empty()
                    && b.samples.iter().all(|s| {
                        s.valid != 0
                            && s.valid & !7 == 0
                            && [s.accel, s.gyro, s.mag].iter().enumerate().all(|(i, v)| {
                                if s.valid & (1 << i) == 0 {
                                    *v == [[0; 4]; 3]
                                } else {
                                    v.iter().all(|b| f32::from_le_bytes(*b).is_finite())
                                }
                            })
                    })
            }
        }
    }
}
const CRC: crc::Crc<u16> = crc::Crc::<u16>::new(&crc::CRC_16_IBM_SDLC);
const RAW_SIZE: usize = 508;
const ENCODED_SIZE: usize = cobs::max_encoding_length(RAW_SIZE);
const _: () = assert!(ENCODED_SIZE < 512);

/// Owns the scratch and output buffers for one complete UART frame.
/// Reuse this encoder; the returned frame remains valid until the next encode.
pub struct MessageEncoder {
    scratch: [u8; RAW_SIZE],
    output: [u8; ENCODED_SIZE + 1],
}

impl MessageEncoder {
    /// Maximum complete wire frame length, including its zero delimiter.
    pub const MAX_FRAME_SIZE: usize = ENCODED_SIZE + 1;

    pub const fn new() -> Self {
        Self {
            scratch: [0; RAW_SIZE],
            output: [0; ENCODED_SIZE + 1],
        }
    }

    /// Serialize exactly one message with CRC, COBS and a final zero delimiter.
    pub fn encode(&mut self, message: &Message) -> MyResult<&[u8]> {
        if !message.valid() {
            return Err(postcard::Error::SerializeBufferFull.into());
        }
        let envelope = Envelope {
            version: 1,
            message: message.clone(),
        };
        let raw =
            postcard::ser_flavors::crc::to_slice_u16(&envelope, &mut self.scratch, CRC.digest())?;
        let size = cobs::try_encode(raw, &mut self.output[..ENCODED_SIZE])?;
        self.output[size] = 0;
        Ok(&self.output[..size + 1])
    }
}

/// Owns receive state across arbitrary UART reads. Emits at most one result per
/// delimiter. Empty delimiters are ignored. Oversized frames discard all bytes
/// through their delimiter; malformed frames cannot contaminate the next frame.
pub struct MessageDecoder {
    buffer: [u8; ENCODED_SIZE],
    length: usize,
    discarding: bool,
}

impl MessageDecoder {
    pub const fn new() -> Self {
        Self {
            buffer: [0; ENCODED_SIZE],
            length: 0,
            discarding: false,
        }
    }

    pub fn feed(&mut self, byte: u8) -> Option<MyResult<Message>> {
        if byte == 0 {
            let length = self.length;
            self.length = 0;
            if self.discarding {
                self.discarding = false;
                return Some(Err(MyError::MessageTooLong));
            }
            if length == 0 {
                return None;
            }
            return Some(self.decode_frame(length));
        }
        if !self.discarding {
            if let Some(slot) = self.buffer.get_mut(self.length) {
                *slot = byte;
                self.length += 1;
            } else {
                self.discarding = true;
            }
        }
        None
    }

    fn decode_frame(&mut self, length: usize) -> MyResult<Message> {
        let size = cobs::decode_in_place(&mut self.buffer[..length])?;
        let payload_size = size
            .checked_sub(size_of::<u16>())
            .ok_or(postcard::Error::DeserializeUnexpectedEnd)?;
        let (payload, checksum) = self.buffer[..size].split_at(payload_size);
        let expected = u16::from_le_bytes([checksum[0], checksum[1]]);
        if CRC.checksum(payload) != expected {
            return Err(postcard::Error::DeserializeBadCrc.into());
        }
        let (envelope, remaining): (Envelope, _) = postcard::take_from_bytes(payload)?;
        if !remaining.is_empty() {
            return Err(postcard::Error::DeserializeBadEncoding.into());
        }
        if envelope.version != 1 || !envelope.message.valid() {
            return Err(postcard::Error::DeserializeBadEncoding.into());
        }
        let mut canonical = [0; RAW_SIZE];
        if postcard::to_slice(&envelope, &mut canonical)? != payload {
            return Err(postcard::Error::DeserializeBadEncoding.into());
        }
        Ok(envelope.message)
    }
}

impl Default for MessageEncoder {
    fn default() -> Self {
        Self::new()
    }
}
impl Default for MessageDecoder {
    fn default() -> Self {
        Self::new()
    }
}
