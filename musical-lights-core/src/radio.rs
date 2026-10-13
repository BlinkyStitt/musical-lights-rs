//! Authenticated, clear-text private LoRa reports. No coordinates are persisted.
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub const PACKET_SIZE: usize = 59;
pub const POSITION_VALID: u16 = 1;
pub const SAMPLE_UTC_VALID: u16 = 2;
pub const ACCURACY_VALID: u16 = 4;
pub const HEADING_VALID: u16 = 8;
pub const MAGNETIC_ONLY: u16 = 16;
pub const CALIBRATING: u16 = 32;
pub const BATTERY_LOW: u16 = 64;
pub const BATTERY_CRITICAL: u16 = 128;
pub const SENSOR_FAULT: u16 = 512;
pub const GPS_FAULT: u16 = 1024;
pub const CLOCK_UNTRUSTED: u16 = 2048;
pub const BATTERY_UNKNOWN: u16 = 4096;
pub const RADIO_FAULT: u16 = 8192;

pub fn valid_health(flags: u16) -> bool {
    flags & 0xc100 == 0
        && (flags & SAMPLE_UTC_VALID == 0 || flags & POSITION_VALID != 0)
        && (flags & ACCURACY_VALID == 0 || flags & POSITION_VALID != 0)
        && (flags & MAGNETIC_ONLY == 0 || flags & HEADING_VALID != 0)
        && (flags & (CALIBRATING | SENSOR_FAULT) == 0
            || flags & (HEADING_VALID | MAGNETIC_ONLY) == 0)
        && (flags & (BATTERY_LOW | BATTERY_CRITICAL | BATTERY_UNKNOWN)).count_ones() <= 1
        && (flags & GPS_FAULT == 0 || flags & POSITION_VALID == 0)
        && (flags & CLOCK_UNTRUSTED == 0 || flags & SAMPLE_UTC_VALID == 0)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub id: u16,
    pub color: u8,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roster {
    pub revision: u32,
    pub peers: heapless::Vec<Identity, 8>,
}
impl Roster {
    pub fn validate(&self, own_id: u16) -> bool {
        self.revision != 0
            && !self.peers.is_empty()
            && self.peers.iter().any(|p| p.id == own_id)
            && self
                .peers
                .iter()
                .all(|p| p.id != 0 && p.id != u16::MAX && p.color < 8)
            && self.peers.windows(2).all(|p| p[0].id < p[1].id)
            && (0..self.peers.len()).all(|i| {
                self.peers[..i]
                    .iter()
                    .all(|p| p.color != self.peers[i].color)
            })
    }
    pub fn slot(&self, id: u16) -> Option<u8> {
        self.peers.iter().position(|p| p.id == id).map(|i| i as u8)
    }
    pub fn identity(&self, id: u16) -> Option<Identity> {
        self.peers.iter().copied().find(|p| p.id == id)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub group: u32,
    pub origin: u16,
    pub relay: u16,
    pub boot: u32,
    pub sequence: u32,
    pub utc_ms: u64,
    pub age_ms: u32,
    pub latitude_e7: i32,
    pub longitude_e7: i32,
    pub accuracy_dm: u16,
    pub color: u8,
    pub flags: u16,
    pub hop: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RadioError {
    Length,
    Authentication,
    Invalid,
    Group,
    UnknownPeer,
    Replay,
    Expired,
    Future,
}
impl Report {
    pub fn valid(&self) -> bool {
        let position = self.flags & POSITION_VALID != 0;
        let utc = self.flags & SAMPLE_UTC_VALID != 0;
        let accuracy = self.flags & ACCURACY_VALID != 0;
        valid_health(self.flags) && self.group != 0 && self.origin != 0 && self.origin != u16::MAX
            && self.relay != 0 && self.relay != u16::MAX && self.boot != 0 && self.sequence != 0
            && self.color < 8 && self.flags & 0xc100 == 0 // Removed input-fault bit is reserved.
            && ((self.hop == 1 && self.origin == self.relay) || (self.hop == 2 && self.origin != self.relay))
            && (!position || ((-900000000..=900000000).contains(&self.latitude_e7) && (-1800000000..=1800000000).contains(&self.longitude_e7)))
            && (position || (self.latitude_e7 == 0 && self.longitude_e7 == 0 && self.accuracy_dm == 0 && self.utc_ms == 0 && self.age_ms == 0))
            && (!utc || (position && self.utc_ms != 0 && self.flags & CLOCK_UNTRUSTED == 0))
            && (utc || self.utc_ms == 0)
            && (!accuracy || (position && (1..u16::MAX).contains(&self.accuracy_dm)))
            && (!position || accuracy || self.accuracy_dm == u16::MAX)
            && (self.flags & MAGNETIC_ONLY == 0 || self.flags & HEADING_VALID != 0)
            && (self.flags & (CALIBRATING | SENSOR_FAULT) == 0 || self.flags & (HEADING_VALID | MAGNETIC_ONLY) == 0)
            && (self.flags & (BATTERY_LOW | BATTERY_CRITICAL | BATTERY_UNKNOWN)).count_ones() <= 1
            && (self.flags & GPS_FAULT == 0 || !position)
    }
    pub fn encode(self, key: &[u8; 32]) -> Result<[u8; PACKET_SIZE], RadioError> {
        if !self.valid() {
            return Err(RadioError::Invalid);
        }
        let mut bytes = [0; PACKET_SIZE];
        bytes[0] = 1;
        bytes[1..5].copy_from_slice(&self.group.to_le_bytes());
        bytes[5..7].copy_from_slice(&self.origin.to_le_bytes());
        bytes[7..9].copy_from_slice(&self.relay.to_le_bytes());
        bytes[9..13].copy_from_slice(&self.boot.to_le_bytes());
        bytes[13..17].copy_from_slice(&self.sequence.to_le_bytes());
        bytes[17..25].copy_from_slice(&self.utc_ms.to_le_bytes());
        bytes[25..29].copy_from_slice(&self.age_ms.to_le_bytes());
        bytes[29..33].copy_from_slice(&self.latitude_e7.to_le_bytes());
        bytes[33..37].copy_from_slice(&self.longitude_e7.to_le_bytes());
        bytes[37..39].copy_from_slice(&self.accuracy_dm.to_le_bytes());
        bytes[39] = self.color;
        bytes[40..42].copy_from_slice(&self.flags.to_le_bytes());
        bytes[42] = self.hop;
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("fixed HMAC key");
        mac.update(&bytes[..43]);
        bytes[43..].copy_from_slice(&mac.finalize().into_bytes()[..16]);
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8], key: &[u8; 32]) -> Result<Self, RadioError> {
        if bytes.len() != PACKET_SIZE {
            return Err(RadioError::Length);
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("fixed HMAC key");
        mac.update(&bytes[..43]);
        mac.verify_truncated_left(&bytes[43..])
            .map_err(|_| RadioError::Authentication)?;
        let report = Self {
            group: u32::from_le_bytes(bytes[1..5].try_into().unwrap()),
            origin: u16::from_le_bytes(bytes[5..7].try_into().unwrap()),
            relay: u16::from_le_bytes(bytes[7..9].try_into().unwrap()),
            boot: u32::from_le_bytes(bytes[9..13].try_into().unwrap()),
            sequence: u32::from_le_bytes(bytes[13..17].try_into().unwrap()),
            utc_ms: u64::from_le_bytes(bytes[17..25].try_into().unwrap()),
            age_ms: u32::from_le_bytes(bytes[25..29].try_into().unwrap()),
            latitude_e7: i32::from_le_bytes(bytes[29..33].try_into().unwrap()),
            longitude_e7: i32::from_le_bytes(bytes[33..37].try_into().unwrap()),
            accuracy_dm: u16::from_le_bytes(bytes[37..39].try_into().unwrap()),
            color: bytes[39],
            flags: u16::from_le_bytes(bytes[40..42].try_into().unwrap()),
            hop: bytes[42],
        };
        if bytes[0] != 1 || !report.valid() {
            return Err(RadioError::Invalid);
        }
        Ok(report)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freshness {
    Fresh,
    Stale,
    Expired,
    Unverified,
}
#[derive(Clone, Copy, Debug)]
pub struct PeerState {
    pub report: Report,
    pub received_ms: u64,
    pub age_at_receive: u32,
    pub verified: bool,
}
impl PeerState {
    /// Receiver freshness is distinct from the origin's UTC-valid flag.
    pub fn snapshot(&self, now: u64) -> crate::message::Peer {
        use crate::message::{L2, L4, Peer, Position};
        let r = self.report;
        Peer {
            id: L2::new(r.origin),
            origin_boot: L4::new(r.boot),
            sequence: L4::new(r.sequence),
            position: Position {
                lat: L4::new(r.latitude_e7 as u32),
                lon: L4::new(r.longitude_e7 as u32),
                age: L4::new(self.age(now)),
                accuracy: L2::new(r.accuracy_dm),
                flags: L2::new(r.flags & 7),
            },
            health: L2::new(r.flags),
            hop: r.hop,
            rssi: L2::new(i16::MIN as u16),
            snr: i8::MIN as u8,
            color: r.color,
            freshness_verified: self.verified,
        }
    }
    pub fn age(&self, now: u64) -> u32 {
        self.age_at_receive
            .saturating_add(now.saturating_sub(self.received_ms).min(u32::MAX as u64) as u32)
    }
    pub fn freshness(&self, now: u64) -> Freshness {
        match self.age(now) {
            60001.. => Freshness::Expired,
            15001.. => Freshness::Stale,
            _ if !self.verified => Freshness::Unverified,
            _ => Freshness::Fresh,
        }
    }
}
#[derive(Clone, Copy)]
struct Pending {
    report: Report,
    received_ms: u64,
    due_ms: u64,
    deadline_ms: u64,
}
/// Eight bounded origin slots, one relay token per five seconds. Own TX has priority.
pub struct Network {
    pub own_id: u16,
    pub group: u32,
    pub roster: Roster,
    pub relay_enabled: bool,
    pub peers: [Option<PeerState>; 8],
    pending: [Option<Pending>; 8],
    relay_token_at: u64,
    pub relay_drops: u32,
}
impl Network {
    pub fn new(own_id: u16, group: u32, roster: Roster, relay_enabled: bool) -> Option<Self> {
        if group == 0 || !roster.validate(own_id) {
            return None;
        }
        Some(Self {
            own_id,
            group,
            roster,
            relay_enabled,
            peers: [None; 8],
            pending: [None; 8],
            relay_token_at: 0,
            relay_drops: 0,
        })
    }
    pub fn receive(
        &mut self,
        report: Report,
        now: u64,
        utc: Option<(u64, u32)>,
        random: u32,
    ) -> Result<(), RadioError> {
        if !report.valid() {
            return Err(RadioError::Invalid);
        }
        if report.group != self.group {
            return Err(RadioError::Group);
        }
        let slot = self
            .roster
            .slot(report.origin)
            .ok_or(RadioError::UnknownPeer)? as usize;
        if report.origin == self.own_id
            || self.roster.identity(report.origin).map(|p| p.color) != Some(report.color)
            || self.roster.identity(report.relay).is_none()
        {
            return Err(RadioError::UnknownPeer);
        }
        if let Some(pending) = self.pending[slot]
            && report.hop == 2
            && (report.boot, report.sequence) == (pending.report.boot, pending.report.sequence)
            && report.age_ms >= pending.report.age_ms
        {
            self.pending[slot] = None;
        }
        if self.peers[slot].is_some_and(|old| {
            (report.boot, report.sequence) <= (old.report.boot, old.report.sequence)
        }) {
            return Err(RadioError::Replay);
        }
        let mut age = report.age_ms;
        let mut verified = false;
        if report.flags & SAMPLE_UTC_VALID != 0
            && let Some((utc, uncertainty)) = utc
        {
            let error = uncertainty as u64 + 250;
            if report.utc_ms > utc.saturating_add(2000 + error) {
                return Err(RadioError::Future);
            }
            age = age.max(
                utc.saturating_add(error)
                    .saturating_sub(report.utc_ms)
                    .min(u32::MAX as u64) as u32,
            );
            verified = true;
            if let Some(old) = self.peers[slot]
                && old.report.flags & SAMPLE_UTC_VALID != 0
                && report.utc_ms < old.report.utc_ms
            {
                return Err(RadioError::Replay);
            }
        }
        if report.flags & POSITION_VALID != 0 && age > 60000 {
            return Err(RadioError::Expired);
        }
        self.peers[slot] = Some(PeerState {
            report,
            received_ms: now,
            age_at_receive: age,
            verified,
        });
        self.pending[slot] = if self.relay_enabled && report.hop == 1 {
            Some(Pending {
                report,
                received_ms: now,
                due_ms: now.saturating_add(100 + (random % 401) as u64),
                deadline_ms: now.saturating_add(1000),
            })
        } else {
            None
        };
        Ok(())
    }
    pub fn has_due_relay(&self, now: u64) -> bool {
        self.pending.iter().flatten().any(|p| now >= p.due_ms)
    }
    pub fn next_relay(
        &mut self,
        now: u64,
        own_due: bool,
        channel_busy: bool,
        random: u32,
    ) -> Option<Report> {
        if own_due {
            return None;
        }
        for pending in &mut self.pending {
            let Some(p) = pending.as_mut() else {
                continue;
            };
            let residence = now.saturating_sub(p.received_ms).min(u32::MAX as u64) as u32;
            if now > p.deadline_ms
                || (p.report.flags & POSITION_VALID != 0
                    && p.report.age_ms.saturating_add(residence) > 60000)
            {
                *pending = None;
                self.relay_drops = self.relay_drops.saturating_add(1);
                continue;
            }
            if now < p.due_ms {
                continue;
            }
            if now < self.relay_token_at {
                *pending = None;
                self.relay_drops = self.relay_drops.saturating_add(1);
                continue;
            }
            if channel_busy {
                p.due_ms = now.saturating_add(20 + (random % 81) as u64);
                continue;
            }
            let mut report = p.report;
            report.relay = self.own_id;
            report.hop = 2;
            if report.flags & POSITION_VALID != 0 {
                report.age_ms = report.age_ms.saturating_add(residence);
            }
            *pending = None;
            self.relay_token_at = now.saturating_add(5000);
            return Some(report);
        }
        None
    }
}
