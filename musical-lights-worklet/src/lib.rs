//! A DOM-free numeric WASM interface, owned by one AudioWorklet instance.
//! Allocation occurs at creation or diagnostic setup, never while processing audio.
//! No browser API imports.
use musical_lights_core::audio::{
    loudness::{Calibration, LoudnessError, SAMPLE_RATE, SoundField},
    policy::VisualOptions,
    presentation::LoudnessSnapshot,
    processor::LoudnessProcessor,
    readouts::Readouts,
    settings::AudioSettings,
};
use musical_lights_core::lights::dance::IdlePeak;
const INPUT_CAPACITY: usize = 4096;
const TRACE_CAPACITY: usize = 64;
const SNAPSHOT_SIZE: usize = LoudnessSnapshot::TRANSPORT_LEN;
const TRACE_STRIDE: usize = 315 + SNAPSHOT_SIZE + 48;

/// Idle visual adapter; no processor, audio session, or heap allocation needed.
#[unsafe(no_mangle)]
pub extern "C" fn preview_level(seconds: f64, band: u32, reduced: u32) -> f64 {
    musical_lights_core::lights::musical_motion::idle_wave(band as usize, 24, seconds, reduced != 0)
}

#[unsafe(no_mangle)]
pub extern "C" fn preview_create() -> *mut IdlePeak {
    Box::into_raw(Box::default())
}
/// # Safety
/// `handle` must be a live pointer returned by `preview_create`, owned by this worker.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn preview_accent(handle: *mut IdlePeak, seconds: f64, reduced: u32) -> u32 {
    // SAFETY: the preview worker owns this handle for its entire lifetime.
    unsafe { handle.as_mut() }.is_some_and(|p| p.push(seconds, reduced != 0)) as u32
}

struct AudioProcessor {
    core: LoudnessProcessor,
    readouts: Readouts,
    calibration: Calibration,
    settings: AudioSettings,
    settings_input: [f64; AudioSettings::LEN],
    visual_input: [f64; 4],
    revision: u32,
    microphone: bool,
    options: VisualOptions,
    queued: Option<(u32, AudioSettings, VisualOptions)>,
    readout_values: [f64; 4],
    input: [f32; INPUT_CAPACITY],
    snapshot: [f64; SNAPSHOT_SIZE],
    started: bool,
    chunk_phase: usize,
    reduced: bool,
    error_code: u32,
    error_detail: u32,
    rms_power: f64,
    rms_count: u32,
    reference_level: Option<f64>,
    calibration_result: f32,
    clipped: u64,
    trace: Option<Box<[f64]>>,
    trace_count: usize,
    trace_dropped: u32,
}
impl AudioProcessor {
    fn new(calibration: Calibration, reduced: bool) -> Self {
        let settings = AudioSettings::default();
        Self {
            core: LoudnessProcessor::new(calibration, SoundField::Free, settings),
            readouts: Readouts::new(settings),
            calibration,
            settings,
            settings_input: settings.values(),
            visual_input: VisualOptions::default().values(),
            revision: 0,
            microphone: false,
            options: VisualOptions::default(),
            queued: None,
            readout_values: [0.0; 4],
            input: [0.0; INPUT_CAPACITY],
            snapshot: [0.0; SNAPSHOT_SIZE],
            started: false,
            chunk_phase: 0,
            reduced,
            error_code: 0,
            error_detail: 0,
            rms_power: 0.0,
            rms_count: 0,
            reference_level: None,
            calibration_result: 0.0,
            clipped: 0,
            trace: None,
            trace_count: 0,
            trace_dropped: 0,
        }
    }
    fn configure(&mut self) -> bool {
        if self.started {
            return false;
        }
        let Some(settings) = AudioSettings::from_values(&self.settings_input) else {
            return false;
        };
        self.settings = settings;
        self.core = LoudnessProcessor::new(self.calibration, SoundField::Free, settings);
        self.core.set_microphone(self.microphone);
        self.readouts = Readouts::new(settings);
        self.update(1)
    }
    fn update(&mut self, revision: u32) -> bool {
        let Some(settings) = AudioSettings::from_values(&self.settings_input) else {
            return false;
        };
        let Some(options) = VisualOptions::from_values(&self.visual_input) else {
            return false;
        };
        if !self.core.queue_settings(revision, settings, options) {
            return false;
        }
        self.queued = Some((revision, settings, options));
        true
    }
    fn process(&mut self, len: usize, first_sample: u64) -> bool {
        if self.error_code != 0 {
            return false;
        }
        if len == 0 || len > INPUT_CAPACITY {
            self.error_code = 1;
            return false;
        }
        if let Some(index) = self.input[..len].iter().position(|v| !v.is_finite()) {
            self.error_code = 2;
            self.error_detail = index as u32;
            return false;
        }
        if !self.started {
            self.core.reset(first_sample);
            self.started = true;
        }
        self.clipped += self.input[..len].iter().filter(|v| v.abs() >= 1.0).count() as u64;
        let mut offset = 0;
        while offset < len {
            let count = self
                .reference_level
                .map_or(len - offset, |_| {
                    (SAMPLE_RATE * 3 - self.rms_count) as usize
                })
                .min(len - offset)
                .min(if self.chunk_phase == 0 {
                    1
                } else {
                    25 - self.chunk_phase
                });
            let pcm = &self.input[offset..offset + count];
            self.chunk_phase = (self.chunk_phase + count) % 24;
            let readouts = &mut self.readouts;
            readouts.push_pcm(pcm);
            let settings = &mut self.settings;
            let revision = &mut self.revision;
            let options = &mut self.options;
            let queued = &mut self.queued;
            let trace = &mut self.trace;
            let trace_count = &mut self.trace_count;
            let trace_dropped = &mut self.trace_dropped;
            if let Err(error) =
                self.core
                    .push_pcm(pcm, first_sample + offset as u64, self.reduced, |result| {
                        if result.revision != *revision {
                            *revision = result.revision;
                            *settings = result.settings;
                            *options = result.options;
                            if queued.as_ref().is_some_and(|p| p.0 == result.revision) {
                                *queued = None;
                            }
                            readouts.configure(result.settings);
                        }
                        let frame = result.loudness;
                        readouts.push_sones(frame.sones);
                        if let Some(trace) = trace.as_mut() {
                            if *trace_count < TRACE_CAPACITY {
                                let row = &mut trace[*trace_count * TRACE_STRIDE
                                    ..(*trace_count + 1) * TRACE_STRIDE];
                                row[0] = frame.sample_index as f64;
                                row[1] = frame.sones;
                                row[2..242].copy_from_slice(&frame.specific_sones_per_bark);
                                for (out, value) in row[242..266].iter_mut().zip(frame.bands()) {
                                    *out = value as f64;
                                }
                                row[266] = result.snapshot.gain;
                                row[267..291].copy_from_slice(result.novelty);
                                row[291..315].copy_from_slice(result.magnitude);
                                result
                                    .snapshot
                                    .write_transport(&mut row[315..315 + SNAPSHOT_SIZE]);
                                for i in 0..24 {
                                    row[315 + SNAPSHOT_SIZE + i] =
                                        result.acoustic_events[i].unwrap_or(-1.0);
                                    row[339 + SNAPSHOT_SIZE + i] = result.suppressed[i] as f64;
                                }
                                *trace_count += 1;
                            } else {
                                *trace_dropped = trace_dropped.saturating_add(1);
                            }
                        }
                    })
            {
                (self.error_code, self.error_detail) = match error {
                    LoudnessError::NonFiniteSample { index } => (2, index as u32),
                    LoudnessError::Discontinuity { expected, received } => {
                        (3, expected.abs_diff(received).min(u32::MAX as u64) as u32)
                    }
                    LoudnessError::LevelOutOfRange { band } => (4, band as u32),
                    _ => (5, 0),
                };
                return false;
            }
            if let Some(level) = self.reference_level {
                for &sample in pcm {
                    if sample.abs() >= 1.0 {
                        self.error_code = 6;
                        return false;
                    }
                    self.rms_power += f64::from(sample).powi(2);
                    self.rms_count += 1;
                }
                if self.rms_count == SAMPLE_RATE * 3 {
                    let calibration = match Calibration::from_reference(
                        (self.rms_power / self.rms_count as f64).sqrt(),
                        level,
                    ) {
                        Ok(value) => value,
                        Err(_) => {
                            self.error_code = 7;
                            return false;
                        }
                    };
                    self.calibration_result = calibration.pascals_per_unit();
                    self.calibration = calibration;
                    self.reference_level = None;
                    self.core =
                        LoudnessProcessor::new(calibration, SoundField::Free, self.settings);
                    self.core.set_microphone(self.microphone);
                    self.core
                        .queue_settings(self.revision.max(1), self.settings, self.options);
                    if let Some((revision, settings, options)) = self.queued {
                        self.core.queue_settings(revision, settings, options);
                    }
                    self.core.reset(first_sample + (offset + count) as u64);
                    self.chunk_phase = 0;
                    self.readouts = Readouts::new(self.settings);
                }
            }
            offset += count;
        }
        true
    }
}

/// Create a processor. The caller owns the returned handle until destroy.
#[unsafe(no_mangle)]
pub extern "C" fn processor_create(
    measured: u32,
    pascals: f32,
    reduced: u32,
) -> *mut core::ffi::c_void {
    let calibration = if measured != 0 {
        match Calibration::measured(pascals) {
            Ok(c) => c,
            Err(_) => return core::ptr::null_mut(),
        }
    } else {
        Calibration::default()
    };
    Box::into_raw(Box::new(AudioProcessor::new(calibration, reduced != 0))).cast()
}

// The JS owner serializes calls and never retains a reference into memory
// during another call. Each exported operation borrows the handle only here.
macro_rules! export {
    ($name:ident($handle:ident $(, $arg:ident: $ty:ty)*) -> $result:ty, $state:ident => $body:expr) => {
        /// # Safety
        /// `handle` must come from `processor_create`, remain alive, and have
        /// exclusive access for this call. The AudioWorklet owns that access.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name($handle: *mut core::ffi::c_void, $($arg: $ty),*) -> $result {
            let $state = unsafe { &mut *$handle.cast::<AudioProcessor>() };
            $body
        }
    };
}
// Diagnostics are opt-in and bounded. Consumers must report lost rows, never hide them.
export!(processor_trace_enable(handle, enabled: u32) -> (), p => { p.trace = if enabled != 0 { Some(vec![0.0; TRACE_CAPACITY * TRACE_STRIDE].into_boxed_slice()) } else { None }; p.trace_count = 0; p.trace_dropped = 0; });
export!(processor_trace_ptr(handle) -> *const f64, p => p.trace.as_ref().map_or(core::ptr::null(), |trace| trace.as_ptr()));
export!(processor_trace_version(handle) -> u32, _p => 6);
export!(processor_trace_stride(handle) -> usize, _p => TRACE_STRIDE);
export!(processor_trace_count(handle) -> usize, p => p.trace_count);
export!(processor_trace_dropped(handle) -> u32, p => p.trace_dropped);
export!(processor_trace_clear(handle) -> (), p => { p.trace_count = 0; });
export!(processor_input(handle) -> *const f32, p => p.input.as_ptr());
export!(processor_capacity(handle) -> usize, _p => INPUT_CAPACITY);
export!(processor_snapshot(handle) -> *const f64, p => { p.core.snapshot().write_transport(&mut p.snapshot); p.snapshot.as_ptr() });
export!(processor_snapshot_length(handle) -> usize, _p => SNAPSHOT_SIZE);
export!(processor_process(handle, len: usize, first: u64) -> u32, p => u32::from(p.process(len, first)));
export!(processor_motion(handle, reduced: u32) -> (), p => { p.reduced = reduced != 0; });
export!(processor_tempo(handle) -> f32, p => p.core.tempo().bpm);
export!(processor_tempo_confidence(handle) -> f32, p => p.core.tempo().confidence);
export!(processor_sones(handle) -> f64, p => p.core.snapshot().total_sones);
export!(processor_clipped(handle) -> f64, p => p.clipped as f64);
export!(processor_error(handle) -> u32, p => p.error_code);
export!(processor_error_detail(handle) -> u32, p => p.error_detail);
export!(processor_calibration_result(handle) -> f32, p => core::mem::take(&mut p.calibration_result));
export!(processor_calibrate(handle, db_spl: f64) -> u32, p => {
    if !db_spl.is_finite() || p.reference_level.is_some() { return 0; }
    p.reference_level = Some(db_spl); p.rms_power = 0.0; p.rms_count = 0; p.calibration_result = 0.0;
    1
});

/// # Safety
/// Destroy exactly once, after the caller has released all memory views and
/// will make no further calls with this handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn processor_destroy(handle: *mut core::ffi::c_void) {
    unsafe {
        drop(Box::from_raw(handle.cast::<AudioProcessor>()));
    }
}

export!(processor_accent_sequence(handle) -> u32, p => p.core.accent_sequence());

export!(processor_settings_ptr(handle) -> *mut f64, p => p.settings_input.as_mut_ptr());
export!(processor_settings_length(handle) -> usize, _p => AudioSettings::LEN);
export!(processor_configure(handle) -> u32, p => u32::from(p.configure()));
export!(processor_readouts(handle) -> *const f64, p => {
    let value = p.readouts.current();
    p.readout_values = [value.rms_dbfs, value.background_dbfs, value.background_sones, f64::from(value.learning)];
    p.readout_values.as_ptr()
});

export!(processor_visual_ptr(handle) -> *mut f64, p => p.visual_input.as_mut_ptr());
export!(processor_source(handle, microphone: u32) -> (), p => { p.microphone = microphone != 0; p.core.set_microphone(p.microphone); });
export!(processor_update(handle, revision: u32) -> u32, p => u32::from(p.update(revision)));
export!(processor_revision(handle) -> u32, p => p.revision);
