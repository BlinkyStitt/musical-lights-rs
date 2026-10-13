//! Command validation, atomic apply and durable recovery for the sensor board.
use crate::{
    message::{Command, CommandResult, L4},
    provisioning::{self, Coefficients, StmRecord},
    storage::{Flash, Journal, StorageError},
};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub struct CalibrationRun {
    pub id: [u8; 8],
    pub candidate: Option<Coefficients>,
    pub stream: bool,
    pub lease_ms: u64,
}
pub struct Controller<F: Flash> {
    pub journal: Journal<F>,
    pub settings: Option<StmRecord<[u8; 32]>>,
    pub run: Option<CalibrationRun>,
    pub storage_fault: bool,
}
impl<F: Flash> Controller<F> {
    pub fn boot(flash: F) -> Result<Self, StorageError> {
        let mut journal = Journal::open(flash)?;
        let settings = if journal.checkpoint.settings.is_empty() {
            None
        } else {
            let settings: StmRecord<[u8; 32]> =
                provisioning::decode_record(&journal.checkpoint.settings)?;
            if !settings.valid() {
                return Err(StorageError::Corrupt);
            }
            Some(settings)
        };
        let mut checkpoint = journal.checkpoint.clone();
        checkpoint.next_boot()?;
        journal.commit(&checkpoint)?;
        Ok(Self {
            journal,
            settings,
            run: None,
            storage_fault: false,
        })
    }
    pub fn boot_id(&self) -> u32 {
        self.journal.checkpoint.boot.get()
    }
    pub fn generation(&self) -> u32 {
        self.settings.as_ref().map_or(0, |s| s.generation.get())
    }
    pub fn expire(&mut self, now: u64) {
        if self
            .run
            .as_ref()
            .is_some_and(|r| now.saturating_sub(r.lease_ms) > 30000)
        {
            self.run = None;
        }
    }
    pub fn next_boot(&mut self) -> Result<(), StorageError> {
        let mut checkpoint = self.journal.checkpoint.clone();
        checkpoint.next_boot()?;
        if let Err(error) = self.journal.commit(&checkpoint) {
            self.storage_fault = true;
            return Err(error);
        }
        self.run = None;
        Ok(())
    }
    pub fn command(&mut self, c: &Command, now: u64) -> CommandResult {
        self.expire(now);
        let mut result = CommandResult {
            stm_boot: L4::new(self.boot_id()),
            client_epoch: c.client_epoch,
            command_id: c.command_id,
            status: 0,
            result_generation: L4::new(self.generation()),
            data: heapless::Vec::new(),
        };
        if self.storage_fault {
            result.status = 9;
            return result;
        }
        if c.target_stm_boot.get() != self.boot_id()
            || c.client_epoch != self.journal.checkpoint.client_epoch
        {
            result.status = 7;
            return result;
        }
        let mutation = matches!(c.operation, 1 | 2 | 4 | 5);
        if mutation {
            if let Some(old) = self
                .journal
                .checkpoint
                .outcomes
                .iter()
                .find(|o| o.command_id == c.command_id && o.client_epoch == c.client_epoch)
            {
                if old.request_digest != provisioning::request_digest(c) {
                    result.status = 2;
                    return result;
                }
                result.status = if matches!(c.operation, 2 | 4)
                    && old.originating_boot.get() != self.boot_id()
                {
                    5
                } else if old.status == 0 {
                    1
                } else {
                    old.status
                };
                result.result_generation = old.generation;
                if matches!(c.operation, 1 | 5) && result.status == 1 {
                    result.data.extend_from_slice(&old.public_digest).unwrap();
                }
                if c.operation == 2 && result.status == 1 {
                    result.data.extend_from_slice(&c.client_epoch.0).unwrap();
                    result.data.extend_from_slice(&c.command_id.0).unwrap();
                }
                return result;
            }
            if c.command_id.get() <= self.journal.checkpoint.high_water.get() {
                result.status = 6;
                return result;
            }
        }
        let mut settings = self.settings.clone();
        let mut run = self.run.clone();
        let mut digest = [0; 32];
        match c.operation {
            0 if c.data.is_empty() && c.expected_generation.get() == 0 => {
                if let Some(settings) = &settings {
                    result.data = settings.public_bytes().unwrap();
                } else {
                    result.status = 8;
                }
            }
            1 => {
                if c.expected_generation.get() != self.generation() {
                    result.status = 3;
                } else if let Ok(write) =
                    provisioning::decode_record::<StmRecord<Option<[u8; 32]>>>(&c.data)
                {
                    let key = write.key.or_else(|| {
                        self.settings
                            .as_ref()
                            .filter(|s| s.key_id == write.key_id)
                            .map(|s| s.key)
                    });
                    if let Some(key) = key {
                        let candidate = write.map_key(key);
                        let calibration_ok = candidate.calibration
                            == self.settings.as_ref().and_then(|s| s.calibration.clone())
                            || (candidate.calibration.is_none()
                                && self.settings.as_ref().is_some_and(|s| {
                                    s.sensor_profile != candidate.sensor_profile
                                        || s.mount_revision != candidate.mount_revision
                                }));
                        if self.generation().checked_add(1) == Some(candidate.generation.get())
                            && candidate.valid()
                            && calibration_ok
                        {
                            settings = Some(candidate);
                        } else {
                            result.status = 2;
                        }
                    } else {
                        result.status = 2;
                    }
                } else {
                    result.status = 2;
                }
            }
            2 if c.data.as_slice() == [0] && c.expected_generation.get() == 0 => {
                if run.is_some() {
                    result.status = 4;
                } else if settings.is_none() {
                    result.status = 8;
                } else {
                    let mut id = [0; 8];
                    id[..4].copy_from_slice(&c.client_epoch.0);
                    id[4..].copy_from_slice(&c.command_id.0);
                    run = Some(CalibrationRun {
                        id,
                        candidate: None,
                        stream: false,
                        lease_ms: now,
                    });
                    result.data.extend_from_slice(&id).unwrap();
                }
            }
            3 if c.data.len() == 8 && c.expected_generation.get() == 0 => {
                if run
                    .as_ref()
                    .is_some_and(|r| r.id.as_slice() == c.data.as_slice())
                {
                    run = None;
                } else {
                    result.status = 8;
                }
            }
            4 if c.data.len() == 128 && c.expected_generation.get() == 0 => {
                if let (Some(r), Some(s)) = (run.as_mut(), settings.as_ref()) {
                    if r.id.as_slice() != &c.data[..8] {
                        result.status = 8;
                    } else if let Ok(candidate) = postcard::from_bytes::<Coefficients>(&c.data[8..])
                    {
                        if candidate.valid(s.sensor_profile.get(), s.mount_revision.get())
                            && self
                                .journal
                                .checkpoint
                                .calibration_revision
                                .get()
                                .checked_add(1)
                                == Some(candidate.revision.get())
                        {
                            r.candidate = Some(candidate);
                            r.stream = false;
                            r.lease_ms = now;
                        } else {
                            result.status = 2;
                        }
                    } else {
                        result.status = 2;
                    }
                } else {
                    result.status = 8;
                }
            }
            5 if c.data.len() == 40 => {
                if c.expected_generation.get() != self.generation() {
                    result.status = 3;
                } else if let (Some(r), Some(s)) = (run.as_ref(), settings.as_mut()) {
                    if let Some(candidate) = &r.candidate {
                        let mut bytes = [0; 120];
                        postcard::to_slice(candidate, &mut bytes).unwrap();
                        if r.id.as_slice() != &c.data[..8]
                            || Sha256::digest(bytes).as_slice() != &c.data[8..]
                        {
                            result.status = 2;
                        } else if let Some(generation) = s.generation.get().checked_add(1) {
                            s.generation = L4::new(generation);
                            s.calibration = Some(candidate.clone());
                            run = None;
                        } else {
                            result.status = 2;
                        }
                    } else {
                        result.status = 8;
                    }
                } else {
                    result.status = 8;
                }
            }
            6 if c.data.len() == 8 && c.expected_generation.get() == 0 => {
                let epoch = L4(c.data[..4].try_into().unwrap());
                let id = L4(c.data[4..8].try_into().unwrap());
                if let Some(old) = self
                    .journal
                    .checkpoint
                    .outcomes
                    .iter()
                    .find(|o| o.client_epoch == epoch && o.command_id == id)
                {
                    let status = if matches!(old.operation, 2 | 4)
                        && old.originating_boot.get() != self.boot_id()
                    {
                        5
                    } else {
                        old.status
                    };
                    result.data.push(status).unwrap();
                    result.data.extend_from_slice(&old.generation.0).unwrap();
                    result.data.extend_from_slice(&old.public_digest).unwrap();
                } else {
                    result.status = if id.get() <= self.journal.checkpoint.high_water.get() {
                        6
                    } else {
                        8
                    };
                }
            }
            7 if c.data.len() == 16 && c.expected_generation.get() == 0 => {
                if let Some(s) = &settings {
                    let mut mac = Hmac::<Sha256>::new_from_slice(&s.key).unwrap();
                    mac.update(b"SC-KEYCHECK-V1\0");
                    mac.update(&s.group_id.0);
                    mac.update(&s.key_id.0);
                    mac.update(&c.data);
                    result.data.extend_from_slice(&s.key_id.0).unwrap();
                    result
                        .data
                        .extend_from_slice(&mac.finalize().into_bytes()[..16])
                        .unwrap();
                } else {
                    result.status = 8;
                }
            }
            9 if c.data.len() == 9 && c.expected_generation.get() == 0 && c.data[8] <= 1 => {
                if let Some(r) = run.as_mut().filter(|r| r.id.as_slice() == &c.data[..8]) {
                    r.stream = c.data[8] != 0;
                    r.lease_ms = now;
                } else {
                    result.status = 8;
                }
            }
            10 if c.data.len() == 8 && c.expected_generation.get() == 0 => {
                if let Some(candidate) = run
                    .as_ref()
                    .filter(|r| r.id.as_slice() == c.data.as_slice())
                    .and_then(|r| r.candidate.as_ref())
                {
                    let mut bytes = [0; 120];
                    postcard::to_slice(candidate, &mut bytes).unwrap();
                    result
                        .data
                        .extend_from_slice(&Sha256::digest(bytes))
                        .unwrap();
                    let mut heading = [0; 15];
                    postcard::to_slice(&crate::message::Heading::default(), &mut heading).unwrap();
                    result.data.extend_from_slice(&heading).unwrap();
                } else {
                    result.status = 8;
                }
            }
            _ => result.status = 2,
        }
        if mutation && !matches!(result.status, 4 | 7 | 9) {
            let mut checkpoint = self.journal.checkpoint.clone();
            if result.status == 0
                && let Some(s) = &settings
            {
                checkpoint.settings = provisioning::encode_record(s).unwrap();
                checkpoint.calibration_revision =
                    s.calibration.as_ref().map_or(L4::new(0), |c| c.revision);
                let public = s.public_bytes().unwrap();
                digest = provisioning::public_digest(0, &public);
                result.result_generation = s.generation;
            }
            if provisioning::completion(
                &mut checkpoint,
                c,
                result.status,
                result.result_generation.get(),
                digest,
            )
            .is_err()
                || self.journal.commit(&checkpoint).is_err()
            {
                self.storage_fault = true;
                result.status = 9;
                result.data.clear();
                return result;
            }
            if result.status == 0 && matches!(c.operation, 1 | 5) {
                result.data.extend_from_slice(&digest).unwrap();
            }
        }
        if result.status == 0 {
            self.settings = settings;
            self.run = run;
        }
        result
    }
}
