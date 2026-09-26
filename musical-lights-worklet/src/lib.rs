//! A DOM-free numeric WASM interface, owned by one AudioWorklet instance.
//! All allocation occurs when creating the processor. No browser API imports.
use musical_lights_core::audio::{
    browser::{BrowserPresentation, BrowserSnapshot},
    loudness::{Calibration, LoudnessError, LoudnessFrame, LoudnessMeter, SAMPLE_RATE, SoundField},
    partial::{HOP, PartialLoudnessMeter},
    visual::VisualGain,
};

const INPUT_CAPACITY: usize = 4096;
const TRACE_CAPACITY: usize = 64;
const TRACE_STRIDE: usize = 364 + SNAPSHOT_SIZE;

const SNAPSHOT_SIZE: usize = BrowserSnapshot::TRANSPORT_LEN;

struct AudioProcessor {
    meter: LoudnessMeter,
    partial: PartialLoudnessMeter,
    partial_hop: usize,
    iso_frame: LoudnessFrame,
    gain: VisualGain,
    display: BrowserPresentation,
    input: [f32; INPUT_CAPACITY],
    snapshot: [f64; SNAPSHOT_SIZE],
    started: bool,
    reduced: bool,
    error_code: u32,
    error_detail: u32,
    rms_power: f64,
    rms_count: u32,
    reference_level: Option<f64>,
    calibration_result: f32,
    latest_sones: f64,
    clipped: u64,
    trace_enabled: bool,
    trace: [f64; TRACE_CAPACITY * TRACE_STRIDE],
    trace_count: usize,
    trace_dropped: u32,
}

impl AudioProcessor {
    fn new(calibration: Calibration, reduced: bool) -> Self {
        Self {
            meter: LoudnessMeter::new(calibration, SoundField::Free),
            partial: PartialLoudnessMeter::new(calibration),
            partial_hop: 0,
            iso_frame: LoudnessFrame {
                sample_index: 0,
                sones: 0.0,
                specific_sones_per_bark: [0.0; 240],
            },
            gain: VisualGain::default(),
            display: BrowserPresentation::new(0.0),
            input: [0.0; INPUT_CAPACITY],
            snapshot: [0.0; SNAPSHOT_SIZE],
            started: false,
            reduced,
            error_code: 0,
            error_detail: 0,
            rms_power: 0.0,
            rms_count: 0,
            reference_level: None,
            calibration_result: 0.0,
            latest_sones: 0.0,
            clipped: 0,
            trace_enabled: false,
            trace: [0.0; TRACE_CAPACITY * TRACE_STRIDE],
            trace_count: 0,
            trace_dropped: 0,
        }
    }

    fn process(&mut self, len: usize, first_sample: u64) -> bool {
        if self.error_code != 0 {
            return false;
        }
        if len == 0 || len > INPUT_CAPACITY {
            self.error_code = 1;
            return false;
        }
        if !self.started {
            self.meter.reset(first_sample);
            self.partial.reset(first_sample);
            self.display = BrowserPresentation::new(first_sample as f64 / SAMPLE_RATE as f64);
            self.started = true;
        }
        // Validate before either calibration or model state changes.
        if let Some(index) = self.input[..len].iter().position(|v| !v.is_finite()) {
            self.error_code = 2;
            self.error_detail = index as u32;
            return false;
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
                .min(HOP - self.partial_hop);
            let iso_frame = &mut self.iso_frame;
            if let Err(error) = self.meter.push_pcm(
                &self.input[offset..offset + count],
                first_sample + offset as u64,
                |frame| {
                    *iso_frame = frame;
                },
            ) {
                (self.error_code, self.error_detail) = match error {
                    LoudnessError::NonFiniteSample { index } => (2, index as u32),
                    LoudnessError::Discontinuity { expected, received } => (
                        3,
                        expected.abs_diff(received).min(u64::from(u32::MAX)) as u32,
                    ),
                    LoudnessError::LevelOutOfRange { band } => (4, band as u32),
                    _ => (5, 0),
                };
                return false;
            }
            self.latest_sones = self.iso_frame.sones;
            let gain = &mut self.gain;
            let display = &mut self.display;
            let iso = &self.iso_frame;
            let reduced = self.reduced;
            let trace_enabled = self.trace_enabled;
            let trace = &mut self.trace;
            let trace_count = &mut self.trace_count;
            let trace_dropped = &mut self.trace_dropped;
            if self
                .partial
                .push_pcm_with_spectrum(
                    &self.input[offset..offset + count],
                    first_sample + offset as u64,
                    |frame, spectrum| {
                        display.push(
                            frame.sample_index as f64 / SAMPLE_RATE as f64,
                            gain.map_browser_partial(
                                frame.short_term_sones.map(|s| s as f32),
                                iso.sones,
                            ),
                            spectrum,
                            reduced,
                        );
                        if trace_enabled {
                            if *trace_count < TRACE_CAPACITY {
                                let row = &mut trace[*trace_count * TRACE_STRIDE
                                    ..(*trace_count + 1) * TRACE_STRIDE];
                                row[0] = iso.sample_index as f64;
                                row[1] = iso.sones;
                                row[2..242].copy_from_slice(&iso.specific_sones_per_bark);
                                for (out, value) in row[242..266].iter_mut().zip(iso.bands()) {
                                    *out = value as f64;
                                }
                                row[266] = frame.sample_index as f64;
                                row[267..291].copy_from_slice(&frame.instantaneous_sones);
                                row[291..315].copy_from_slice(&frame.short_term_sones);
                                row[315] = gain.factor();
                                row[316..340].copy_from_slice(&display.novelty);
                                row[340..364].copy_from_slice(&display.magnitude);
                                display.snapshot.write_transport(&mut row[364..]);
                                *trace_count += 1;
                            } else {
                                *trace_dropped = trace_dropped.saturating_add(1);
                            }
                        }
                    },
                )
                .is_err()
            {
                self.error_code = 5;
                return false;
            }
            self.partial_hop = (self.partial_hop + count) % HOP;
            if let Some(level) = self.reference_level {
                for &sample in &self.input[offset..offset + count] {
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
                        Ok(calibration) => calibration,
                        Err(_) => {
                            self.error_code = 7;
                            return false;
                        }
                    };
                    self.calibration_result = calibration.pascals_per_unit();
                    self.reference_level = None;
                    self.meter = LoudnessMeter::new(calibration, SoundField::Free);
                    self.meter.reset(first_sample + (offset + count) as u64);
                    self.partial = PartialLoudnessMeter::new(calibration);
                    self.partial.reset(first_sample + (offset + count) as u64);
                    self.partial_hop = 0;
                    self.iso_frame = LoudnessFrame {
                        sample_index: first_sample + (offset + count) as u64,
                        sones: 0.0,
                        specific_sones_per_bark: [0.0; 240],
                    };
                    self.gain = VisualGain::default();
                    self.latest_sones = 0.0;
                    self.display = BrowserPresentation::new(
                        (first_sample + (offset + count) as u64) as f64 / SAMPLE_RATE as f64,
                    );
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
export!(processor_trace_enable(handle, enabled: u32) -> (), p => { p.trace_enabled = enabled != 0; p.trace_count = 0; p.trace_dropped = 0; });
export!(processor_trace_ptr(handle) -> *const f64, p => p.trace.as_ptr());
export!(processor_trace_version(handle) -> u32, _p => 4);
export!(processor_trace_stride(handle) -> usize, _p => TRACE_STRIDE);
export!(processor_trace_count(handle) -> usize, p => p.trace_count);
export!(processor_trace_dropped(handle) -> u32, p => p.trace_dropped);
export!(processor_trace_clear(handle) -> (), p => { p.trace_count = 0; });
export!(processor_input(handle) -> *const f32, p => p.input.as_ptr());
export!(processor_capacity(handle) -> usize, _p => INPUT_CAPACITY);
export!(processor_snapshot(handle) -> *const f64, p => { p.display.snapshot.write_transport(&mut p.snapshot); p.snapshot.as_ptr() });
export!(processor_snapshot_length(handle) -> usize, _p => SNAPSHOT_SIZE);
export!(processor_process(handle, len: usize, first: u64) -> u32, p => u32::from(p.process(len, first)));
export!(processor_motion(handle, reduced: u32) -> (), p => { p.reduced = reduced != 0; });
export!(processor_sones(handle) -> f64, p => p.latest_sones);
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
