//! Analyze every sample before publishing the latest display state.
use anyhow::{bail, ensure};
use cpal::{
    FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
    traits::{DeviceTrait, StreamTrait},
};
use musical_lights_core::audio::{
    loudness::{Calibration, LoudnessMeter, SoundField},
    visual::{DISPLAY_BANDS, DisplaySnapshot, VisualGain},
};
use resampler::{Attenuation, Latency, ResamplerFir, SampleRate};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputIdentity {
    pub device: String,
    pub channel: usize,
    pub channels: u16,
    pub sample_rate: u32,
    pub sample_format: String,
    /// Operator's fixed hardware/OS gain and processing settings; CPAL cannot query them.
    pub fixed_settings: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputProfile {
    pub input: InputIdentity,
    pub pascals_per_unit: f32,
}
#[derive(Clone, Copy, Debug)]
pub struct LiveFrame {
    pub snapshot: DisplaySnapshot<DISPLAY_BANDS>,
    pub sones: f64,
    pub clipped: u64,
    pub input_samples: u64,
    pub reference_samples: u64,
    pub reference_power: f64,
    pub reference_clipped: u64,
    audio_time: f64,
    received_at: Instant,
}
impl LiveFrame {
    pub fn display(&self) -> musical_lights_core::audio::visual::DisplayFrame<DISPLAY_BANDS> {
        self.snapshot
            .frame(self.audio_time + self.received_at.elapsed().as_secs_f64())
    }
    pub fn reference_calibration(&self, rate: u32, db_spl: f64) -> anyhow::Result<Calibration> {
        ensure!(
            self.reference_samples == u64::from(rate) * 3,
            "reference needs three seconds"
        );
        ensure!(
            self.reference_clipped == 0,
            "reference clipped; lower input gain"
        );
        Ok(Calibration::from_reference(
            (self.reference_power / self.reference_samples as f64).sqrt(),
            db_spl,
        )?)
    }
}
struct Shared {
    frame: LiveFrame,
    error: Option<String>,
}
pub struct LiveLoudness {
    pub input: InputIdentity,
    pub calibrated: bool,
    shared: Arc<Mutex<Shared>>,
    _stream: Stream,
}
impl LiveLoudness {
    pub fn new(
        channel: usize,
        profile: Option<InputProfile>,
        fixed_settings: String,
    ) -> anyhow::Result<Self> {
        let (device, selected) = super::input_configuration(48_000)?;
        ensure!(
            channel < usize::from(selected.channels()),
            "input channel {} unavailable",
            channel + 1
        );
        let input = InputIdentity {
            device: device.id()?.to_string(),
            channel,
            channels: selected.channels(),
            sample_rate: selected.sample_rate(),
            sample_format: selected.sample_format().to_string(),
            fixed_settings,
        };
        let calibration = if let Some(profile) = profile {
            ensure!(
                profile.input == input && !input.fixed_settings.trim().is_empty(),
                "calibration does not match the device, channel, rate and fixed settings"
            );
            Calibration::measured(profile.pascals_per_unit)?
        } else {
            Calibration::default()
        };
        let processor = CaptureProcessor::new(input.sample_rate, calibration)?;
        let shared = Arc::new(Mutex::new(Shared {
            frame: processor.frame,
            error: None,
        }));
        let stream = match selected.sample_format() {
            SampleFormat::F32 => build::<f32>(
                &device,
                selected.config(),
                channel,
                processor,
                shared.clone(),
            ),
            SampleFormat::F64 => build::<f64>(
                &device,
                selected.config(),
                channel,
                processor,
                shared.clone(),
            ),
            SampleFormat::I16 => build::<i16>(
                &device,
                selected.config(),
                channel,
                processor,
                shared.clone(),
            ),
            SampleFormat::U16 => build::<u16>(
                &device,
                selected.config(),
                channel,
                processor,
                shared.clone(),
            ),
            SampleFormat::I32 => build::<i32>(
                &device,
                selected.config(),
                channel,
                processor,
                shared.clone(),
            ),
            SampleFormat::U32 => build::<u32>(
                &device,
                selected.config(),
                channel,
                processor,
                shared.clone(),
            ),
            format => bail!("unsupported microphone sample format: {format}"),
        }?;
        stream.play()?;
        Ok(Self {
            input,
            calibrated: calibration.is_measured(),
            shared,
            _stream: stream,
        })
    }
    pub fn latest(&self) -> anyhow::Result<LiveFrame> {
        let state = self
            .shared
            .lock()
            .map_err(|_| anyhow::anyhow!("audio state lock poisoned"))?;
        if let Some(error) = &state.error {
            bail!("{error}");
        }
        ensure!(
            state.frame.received_at.elapsed().as_secs_f64() < 3.0,
            "microphone capture stalled"
        );
        Ok(state.frame)
    }
}
fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channel: usize,
    processor: CaptureProcessor,
    shared: Arc<Mutex<Shared>>,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let (data, error) = capture_callbacks(config, channel, processor, shared);
    device.build_input_stream(config, data, error, None)
}

fn capture_callbacks<T>(
    config: StreamConfig,
    channel: usize,
    mut processor: CaptureProcessor,
    shared: Arc<Mutex<Shared>>,
) -> (
    impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static,
    impl FnMut(cpal::Error) + Send + 'static,
)
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let errors = shared.clone();
    let channels = usize::from(config.channels);
    let mut failure = None;
    (
        move |data: &[T], _info| {
            if failure.is_none() {
                let result = (|| {
                    ensure!(
                        !data.is_empty() && data.len().is_multiple_of(channels),
                        "incomplete input frame"
                    );
                    // CPAL does not expose timestamp precision. ALSA can use
                    // a scheduler clock instead of a sample clock, so these
                    // timestamps cannot establish whether samples were lost.
                    // Count delivered frames; driver discontinuities (including
                    // ALSA Xrun) fail the stream through the error callback.
                    processor.push_interleaved(data, channels, channel)
                })();
                if let Err(error) = result {
                    failure = Some(error.to_string());
                }
            }
            // No raw audio queue and no waiting for the renderer. Retain failures.
            if let Ok(mut state) = shared.try_lock()
                && state.error.is_none()
            {
                if let Some(error) = failure.take() {
                    state.error = Some(error);
                    failure = Some("capture stopped".into());
                } else {
                    state.frame = processor.frame;
                }
            }
        },
        move |error| {
            if let Ok(mut state) = errors.lock() {
                state.error.get_or_insert_with(|| error.to_string());
            }
        },
    )
}

/// The upstream FIR phase-zero center is 63 + 1/1024 input samples. Supply
/// 63 zeros as prehistory. The remaining phase quantization is at most 1/1024
/// input sample (23 ns at 44.1 kHz); the lookahead adds capture latency.
pub struct InputResampler {
    fir: Option<ResamplerFir>,
    output: Vec<f32>,
}
impl InputResampler {
    pub fn new(rate: u32) -> anyhow::Result<Self> {
        ensure!(
            rate >= 44_100,
            "capture bandwidth insufficient for the loudness model"
        );
        let input_rate = SampleRate::try_from(rate)
            .map_err(|()| anyhow::anyhow!("unsupported sample rate {rate}"))?;
        let fir = (rate != 48_000).then(|| {
            ResamplerFir::new(
                1,
                input_rate,
                SampleRate::Hz48000,
                Latency::Sample64,
                Attenuation::Db90,
            )
        });
        let output = vec![0.0; fir.as_ref().map_or(0, ResamplerFir::buffer_size_output)];
        let mut this = Self { fir, output };
        if let Some(fir) = &mut this.fir {
            let (consumed, produced) = fir.resample(&[0.0; 63], &mut this.output)?;
            ensure!(
                consumed == 63 && produced == 0,
                "unexpected FIR prehistory contract"
            );
        }
        Ok(this)
    }
    pub fn push(
        &mut self,
        mut input: &[f32],
        mut emit: impl FnMut(&[f32]) -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        ensure!(
            input.iter().all(|v| v.is_finite()),
            "non-finite input sample"
        );
        let Some(fir) = &mut self.fir else {
            return emit(input);
        };
        loop {
            let (consumed, produced) = fir.resample(input, &mut self.output)?;
            if produced > 0 {
                emit(&self.output[..produced])?;
            }
            input = &input[consumed..];
            if consumed == 0 && produced == 0 {
                ensure!(input.is_empty(), "resampler made no progress");
                break;
            }
        }
        Ok(())
    }
}
struct CaptureProcessor {
    resampler: InputResampler,
    meter: LoudnessMeter,
    gain: VisualGain,
    frame: LiveFrame,
    sample_index: u64,
    reference_length: u64,
    input_rate: u32,
}
impl CaptureProcessor {
    fn new(rate: u32, calibration: Calibration) -> anyhow::Result<Self> {
        Ok(Self {
            resampler: InputResampler::new(rate)?,
            meter: LoudnessMeter::new(calibration, SoundField::Free),
            gain: VisualGain::default(),
            frame: LiveFrame {
                snapshot: DisplaySnapshot::new(0.0),
                sones: 0.0,
                clipped: 0,
                input_samples: 0,
                reference_samples: 0,
                reference_power: 0.0,
                reference_clipped: 0,
                audio_time: 0.0,
                received_at: Instant::now(),
            },
            sample_index: 0,
            reference_length: u64::from(rate) * 3,
            input_rate: rate,
        })
    }
    fn push_interleaved<T: SizedSample>(
        &mut self,
        input: &[T],
        channels: usize,
        channel: usize,
    ) -> anyhow::Result<()>
    where
        f32: FromSample<T>,
    {
        let mut mono = [0.0; 1024];
        // Integer PCM has asymmetric rails. +32767 is full scale even though
        // its correctly normalized value is smaller than one.
        let positive_rail = match T::FORMAT {
            SampleFormat::I16 | SampleFormat::U16 => 32767.0 / 32768.0,
            _ => 1.0,
        };
        for chunk in input.chunks(1024 * channels) {
            let length = chunk.len() / channels;
            for (out, source) in mono.iter_mut().zip(chunk.chunks_exact(channels)) {
                *out = f32::from_sample(source[channel]);
            }
            let input = &mono[..length];
            ensure!(
                input.iter().all(|v| v.is_finite()),
                "non-finite input sample"
            );
            for &value in input {
                let clipped = value <= -1.0 || value >= positive_rail;
                self.frame.input_samples += 1;
                self.frame.clipped += u64::from(clipped);
                if self.frame.reference_samples < self.reference_length {
                    self.frame.reference_samples += 1;
                    self.frame.reference_power += f64::from(value).powi(2);
                    self.frame.reference_clipped += u64::from(clipped);
                }
            }
            let Self {
                resampler,
                meter,
                gain,
                frame,
                sample_index,
                ..
            } = self;
            resampler.push(input, |pcm| {
                meter.push_pcm(pcm, *sample_index, |loudness| {
                    frame.snapshot.push(
                        loudness.sample_index as f64 / 48_000.0,
                        gain.map(&loudness).bands,
                        false,
                    );
                    frame.sones = loudness.sones;
                })?;
                *sample_index += pcm.len() as u64;
                Ok(())
            })?;
        }
        self.frame.received_at = Instant::now();
        self.frame.audio_time = self.frame.input_samples as f64 / f64::from(self.input_rate);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use cpal::StreamInstant;

    #[test]
    fn callback_jitter_does_not_discard_continuous_capture_or_calibration() {
        for rate in [44_100, 48_000] {
            let processor = CaptureProcessor::new(rate, Calibration::default()).unwrap();
            let shared = Arc::new(Mutex::new(Shared {
                frame: processor.frame,
                error: None,
            }));
            let config = StreamConfig {
                channels: 1,
                sample_rate: rate,
                buffer_size: cpal::BufferSize::Default,
            };
            let (mut data, _) = capture_callbacks(config, 0, processor, shared.clone());
            let mut frames = 0;
            let mut callback = 0;
            while frames < 3 * rate {
                let count = [128, 480, 256, 800][callback % 4].min(3 * rate - frames);
                // Scheduler jitter and millisecond timestamp precision, as with
                // clocks that do not identify the first captured sample.
                let jitter = [0.0004, -0.0003, 0.0008, -0.0001][callback % 4];
                let seconds = (1.0 + frames as f64 / rate as f64 + jitter) * 1000.0;
                let capture = StreamInstant::from_millis(seconds.round() as u64);
                let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
                    capture,
                    callback: capture,
                });
                data(&vec![0.25_f32; count as usize], &info);
                frames += count;
                callback += 1;
            }
            let state = shared.lock().unwrap();
            assert!(state.error.is_none(), "{rate}: {:?}", state.error);
            assert_eq!(state.frame.input_samples, u64::from(3 * rate));
            assert_eq!(state.frame.reference_samples, u64::from(3 * rate));
            let calibration = state.frame.reference_calibration(rate, 94.0).unwrap();
            let expected = 2e-5 * 10.0_f64.powf(94.0 / 20.0) / 0.25;
            assert!((f64::from(calibration.pascals_per_unit()) - expected).abs() < 1e-6);
        }
    }

    #[test]
    fn reported_capture_overrun_keeps_the_stream_failed() {
        let processor = CaptureProcessor::new(48_000, Calibration::default()).unwrap();
        let shared = Arc::new(Mutex::new(Shared {
            frame: processor.frame,
            error: None,
        }));
        let config = StreamConfig {
            channels: 1,
            sample_rate: 48_000,
            buffer_size: cpal::BufferSize::Default,
        };
        let (mut data, mut error) = capture_callbacks(config, 0, processor, shared.clone());
        let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
            capture: StreamInstant::ZERO,
            callback: StreamInstant::ZERO,
        });
        data(&[0.25_f32; 128], &info);
        let overrun = cpal::Error::new(cpal::ErrorKind::Xrun);
        error(overrun.clone());
        data(&[0.25_f32; 128], &info);
        let state = shared.lock().unwrap();
        assert_eq!(state.error.as_deref(), Some(overrun.to_string().as_str()));
        assert_eq!(state.frame.input_samples, 128);
        assert!(state.frame.reference_calibration(48_000, 94.0).is_err());
    }
    fn resample(rate: u32, frequency: f64, block: usize) -> Vec<f32> {
        let input: Vec<_> = (0..rate)
            .map(|i| {
                (std::f64::consts::TAU * frequency * i as f64 / rate as f64).sin() as f32 * 0.5
            })
            .collect();
        let mut converter = InputResampler::new(rate).unwrap();
        let mut output = Vec::new();
        for chunk in input.chunks(block) {
            converter
                .push(chunk, |v| {
                    output.extend_from_slice(v);
                    Ok(())
                })
                .unwrap();
        }
        output
    }
    #[test]
    fn fir_preserves_amplitude_phase_partitioning_and_rejects_aliases() {
        for rate in [44_100, 48_000, 96_000] {
            let reference = resample(rate, 1000.0, 800);
            // The upstream 1024-phase FIR has up to one phase of f64 clock rounding.
            // At 1 kHz/44.1 kHz, that bounds PCM error below 0.0001.
            for block in [1, 128, 4096] {
                let other = resample(rate, 1000.0, block);
                let max = reference
                    .iter()
                    .zip(&other)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0, f32::max);
                assert!(
                    reference.len() == other.len() && max < 0.0001,
                    "{rate} block {block}: lengths {} {}, error {max}",
                    reference.len(),
                    other.len()
                );
            }
            let stable = &reference[4800..43_200];
            let rms = (stable.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>()
                / stable.len() as f64)
                .sqrt();
            assert!((rms - 0.5 / 2.0f64.sqrt()).abs() < 0.0001, "{rate}: {rms}");
            let error = stable
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    (f64::from(*v)
                        - 0.5
                            * (std::f64::consts::TAU * 1000.0 * (i + 4800) as f64 / 48_000.0).sin())
                    .abs()
                })
                .fold(0.0, f64::max);
            assert!(error < 0.0002, "{rate}: phase error {error}");
        }
        let rejected = resample(96_000, 30_000.0, 128);
        let peak = rejected[4800..43_200]
            .iter()
            .copied()
            .map(f32::abs)
            .fold(0.0, f32::max);
        assert!(peak < 0.00005, "alias peak {peak}");
        assert!(InputResampler::new(16_000).is_err());
    }
    #[test]
    fn channel_selection_keeps_opposite_phase_channels_and_every_frame() {
        let input: Vec<_> = (0..48_000)
            .flat_map(|i| {
                let v = (std::f32::consts::TAU * 1000.0 * i as f32 / 48_000.0).sin() * 0.1;
                [v, -v]
            })
            .collect();
        let mut a = CaptureProcessor::new(48_000, Calibration::default()).unwrap();
        let mut b = CaptureProcessor::new(48_000, Calibration::default()).unwrap();
        for block in input.chunks(256) {
            a.push_interleaved(block, 2, 0).unwrap();
        }
        b.push_interleaved(&input, 2, 1).unwrap();
        assert!(a.frame.sones > 1.0);
        assert_eq!(a.frame.sones, b.frame.sones);
        assert_eq!(a.frame.snapshot, b.frame.snapshot);
        assert_eq!(a.frame.input_samples, 48_000);
        assert_eq!(a.frame.audio_time, 1.0);
    }

    #[test]
    fn integer_rails_count_as_clipping_without_changing_pcm_scale() {
        let mut capture = CaptureProcessor::new(48_000, Calibration::default()).unwrap();
        capture
            .push_interleaved(&[i16::MIN, i16::MAX, i16::MAX - 1, 0], 1, 0)
            .unwrap();
        assert_eq!(capture.frame.clipped, 2);
        assert_eq!(capture.frame.reference_clipped, 2);
        assert_eq!(capture.frame.reference_samples, 4);
        assert_eq!(
            capture.frame.reference_power,
            1.0 + (32767.0_f64 / 32768.0).powi(2) + (32766.0_f64 / 32768.0).powi(2)
        );
    }
}
