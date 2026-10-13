//! Dual-sector, commit-last checkpoints. Stored records contain no coordinates.
use crate::message::{L2, L4};
use serde::{Deserialize, Serialize};
pub const PAGE: usize = 4096;
pub const SECTOR: usize = 128 * 1024;
const COMMIT: usize = PAGE - 4;
const CRC: crc::Crc<u32> = crc::Crc::<u32>::new(&crc::CRC_32_ISO_HDLC);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageError {
    Io,
    Corrupt,
    Exhausted,
    TooLarge,
}
pub trait Flash {
    fn read(&mut self, offset: usize, data: &mut [u8]) -> Result<(), StorageError>;
    fn write(&mut self, offset: usize, data: &[u8]) -> Result<(), StorageError>;
    fn erase(&mut self, offset: usize, length: usize) -> Result<(), StorageError>;
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outcome {
    pub client_epoch: L4,
    pub command_id: L4,
    pub operation: u8,
    pub status: u8,
    pub originating_boot: L4,
    pub generation: L4,
    pub request_digest: [u8; 32],
    pub public_digest: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub schema: L2,
    pub boot: L4,
    pub client_epoch: L4,
    pub high_water: L4,
    pub calibration_revision: L4,
    pub settings: heapless::Vec<u8, 384>,
    pub outcomes: heapless::Vec<Outcome, 32>,
}
impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            schema: L2::new(1),
            boot: L4::new(0),
            client_epoch: L4::new(1),
            high_water: L4::new(0),
            calibration_revision: L4::new(0),
            settings: heapless::Vec::new(),
            outcomes: heapless::Vec::new(),
        }
    }
}
impl Checkpoint {
    pub fn next_boot(&mut self) -> Result<u32, StorageError> {
        let boot = self
            .boot
            .get()
            .checked_add(1)
            .ok_or(StorageError::Exhausted)?;
        self.boot = L4::new(boot);
        Ok(boot)
    }
    pub fn record(&mut self, outcome: Outcome) -> Result<(), StorageError> {
        if outcome.client_epoch != self.client_epoch
            || outcome.command_id.get() <= self.high_water.get()
        {
            return Err(StorageError::Corrupt);
        }
        self.high_water = outcome.command_id;
        if self.outcomes.is_full() {
            self.outcomes.remove(0);
        }
        self.outcomes
            .push(outcome)
            .map_err(|_| StorageError::TooLarge)
    }
}

pub struct Journal<F: Flash> {
    flash: F,
    sector: usize,
    generation: u64,
    transaction: u64,
    next_slot: usize,
    pub checkpoint: Checkpoint,
}
fn header(page: &[u8; PAGE]) -> Result<Option<u64>, StorageError> {
    if page[COMMIT..] != [0; 4] {
        return Ok(None);
    }
    if &page[..4] != b"SCS1"
        || page[4..8] != [1, 0, 0, 0]
        || CRC.checksum(&page[..16]) != u32::from_le_bytes(page[16..20].try_into().unwrap())
    {
        return Err(StorageError::Corrupt);
    }
    let generation = u64::from_le_bytes(page[8..16].try_into().unwrap());
    if generation == 0 {
        return Err(StorageError::Corrupt);
    }
    Ok(Some(generation))
}
fn decode(page: &[u8; PAGE]) -> Result<Option<(u64, Checkpoint)>, StorageError> {
    if page[COMMIT..] != [0; 4] {
        return Ok(None);
    }
    if &page[..4] != b"SCJ1" || page[4..6] != [1, 0] {
        return Err(StorageError::Corrupt);
    }
    let length = u16::from_le_bytes(page[6..8].try_into().unwrap()) as usize;
    if length > 4000 {
        return Err(StorageError::Corrupt);
    }
    let mut digest = CRC.digest();
    digest.update(&page[..16]);
    digest.update(&page[20..20 + length]);
    if digest.finalize() != u32::from_le_bytes(page[16..20].try_into().unwrap()) {
        return Err(StorageError::Corrupt);
    }
    let (value, remaining): (Checkpoint, _) =
        postcard::take_from_bytes(&page[20..20 + length]).map_err(|_| StorageError::Corrupt)?;
    if !remaining.is_empty() || value.schema.get() != 1 {
        return Err(StorageError::Corrupt);
    }
    let mut canonical = [0; 4000];
    if postcard::to_slice(&value, &mut canonical).map_err(|_| StorageError::Corrupt)?
        != &page[20..20 + length]
    {
        return Err(StorageError::Corrupt);
    }
    let transaction = u64::from_le_bytes(page[8..16].try_into().unwrap());
    if transaction == 0 {
        return Err(StorageError::Corrupt);
    }
    Ok(Some((transaction, value)))
}
impl<F: Flash> Journal<F> {
    pub fn open(mut flash: F) -> Result<Self, StorageError> {
        let mut page = [0; PAGE];
        let mut selected = None;
        let mut erased = true;
        for sector in 0..2 {
            flash.read(sector * SECTOR, &mut page)?;
            if let Some(generation) = header(&page)?
                && selected.is_none_or(|(_, old)| generation > old)
            {
                selected = Some((sector, generation));
            }
            for slot in 0..32 {
                flash.read(sector * SECTOR + slot * PAGE, &mut page)?;
                erased &= page.iter().all(|b| *b == 255);
            }
        }
        let Some((sector, generation)) = selected else {
            if !erased {
                return Err(StorageError::Corrupt);
            }
            let mut result = Self {
                flash,
                sector: 0,
                generation: 0,
                transaction: 0,
                next_slot: 32,
                checkpoint: Checkpoint::default(),
            };
            result.commit(&Checkpoint::default())?;
            return Ok(result);
        };
        let mut checkpoint = None;
        let mut transaction = 0;
        let mut next_slot = 1;
        for slot in 1..32 {
            flash.read(sector * SECTOR + slot * PAGE, &mut page)?;
            if page.iter().any(|b| *b != 255) {
                next_slot = slot + 1;
            }
            if let Some((id, value)) = decode(&page)? {
                if id <= transaction {
                    return Err(StorageError::Corrupt);
                }
                transaction = id;
                checkpoint = Some(value);
            }
        }
        Ok(Self {
            flash,
            sector,
            generation,
            transaction,
            next_slot,
            checkpoint: checkpoint.ok_or(StorageError::Corrupt)?,
        })
    }
    pub fn commit(&mut self, checkpoint: &Checkpoint) -> Result<(), StorageError> {
        let transaction = self
            .transaction
            .checked_add(1)
            .ok_or(StorageError::Exhausted)?;
        let rollover = self.next_slot >= 32;
        let sector = if rollover {
            1 - self.sector
        } else {
            self.sector
        };
        let slot = if rollover { 1 } else { self.next_slot };
        let generation = if rollover {
            self.generation
                .checked_add(1)
                .ok_or(StorageError::Exhausted)?
        } else {
            self.generation
        };
        if rollover {
            self.flash.erase(sector * SECTOR, SECTOR)?;
            let mut erased = [0; PAGE];
            for offset in (0..SECTOR).step_by(PAGE) {
                self.flash.read(sector * SECTOR + offset, &mut erased)?;
                if erased.iter().any(|v| *v != 255) {
                    return Err(StorageError::Io);
                }
            }
            let mut header = [255; PAGE];
            header[..4].copy_from_slice(b"SCS1");
            header[4..8].copy_from_slice(&[1, 0, 0, 0]);
            header[8..16].copy_from_slice(&generation.to_le_bytes());
            let crc = CRC.checksum(&header[..16]);
            header[16..20].copy_from_slice(&crc.to_le_bytes());
            self.flash.write(sector * SECTOR, &header)?;
            self.flash.read(sector * SECTOR, &mut erased)?;
            if header != erased {
                return Err(StorageError::Io);
            }
        }
        let mut page = [255; PAGE];
        page[..4].copy_from_slice(b"SCJ1");
        page[4..6].copy_from_slice(&1u16.to_le_bytes());
        let length = postcard::to_slice(checkpoint, &mut page[20..4020])
            .map_err(|_| StorageError::TooLarge)?
            .len();
        page[6..8].copy_from_slice(&(length as u16).to_le_bytes());
        page[8..16].copy_from_slice(&transaction.to_le_bytes());
        let mut crc = CRC.digest();
        crc.update(&page[..16]);
        crc.update(&page[20..20 + length]);
        page[16..20].copy_from_slice(&crc.finalize().to_le_bytes());
        let offset = sector * SECTOR + slot * PAGE;
        // Reserve the slot before programming: a failed write is never overwritten.
        if !rollover {
            self.next_slot += 1;
        }
        self.flash.write(offset, &page)?;
        let mut verify = [0; PAGE];
        self.flash.read(offset, &mut verify)?;
        if verify != page {
            return Err(StorageError::Io);
        }
        self.flash.write(offset + COMMIT, &[0; 4])?;
        self.flash.read(offset, &mut verify)?;
        decode(&verify)?.ok_or(StorageError::Io)?;
        if rollover {
            self.flash.write(sector * SECTOR + COMMIT, &[0; 4])?;
            self.flash.read(sector * SECTOR, &mut verify)?;
            if header(&verify)? != Some(generation) {
                return Err(StorageError::Io);
            }
        }
        self.sector = sector;
        self.generation = generation;
        self.transaction = transaction;
        self.next_slot = slot + 1;
        self.checkpoint = checkpoint.clone();
        Ok(())
    }
    pub fn into_flash(self) -> F {
        self.flash
    }
}
