use anyhow::{Context, bail, ensure};
use cpal::{
    FromSample, Sample, SampleFormat, SampleRate, SizedSample, Stream, StreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use musical_lights_core::{
    audio::Samples,
    logging::{error, info},
};

/// Owns the input stream. Dropping this value stops microphone capture.
pub struct MicrophoneStream<const SAMPLES: usize> {
    pub sample_rate: SampleRate,
    pub stream: flume::Receiver<Samples<SAMPLES>>,
    _stream: Stream,
}

impl<const SAMPLES: usize> MicrophoneStream<SAMPLES> {
    pub fn try_new(preferred_rate: u32) -> anyhow::Result<Self> {
        ensure!(SAMPLES > 0, "microphone block size must be positive");
        let host = cpal::default_host();
        let mut preferred = None;
        for device in host.input_devices()? {
            let description = device.description()?;
            info!("host input device: {}", description.name());
            if description.name() == "Loopback Audio" {
                preferred = Some(device);
                break;
            }
            if description.name() == "MacBook Pro Microphone" {
                preferred = Some(device);
            }
        }
        let device = preferred
            .or_else(|| host.default_input_device())
            .context("no microphone input device is available")?;
        let default = device.default_input_config()?;
        let supported = device.supported_input_configs()?.find(|config| {
            config.sample_format() == default.sample_format()
                && config.channels() == default.channels()
                && config.min_sample_rate() <= preferred_rate
                && preferred_rate <= config.max_sample_rate()
        });
        let selected = supported.map_or(default, |config| config.with_sample_rate(preferred_rate));
        let sample_rate = selected.sample_rate();
        let format = selected.sample_format();
        let config = selected.config();
        info!(
            "microphone: {} Hz, {} channels, {}",
            sample_rate, config.channels, format
        );
        let (tx, rx) = flume::bounded(2);
        let stream = match format {
            SampleFormat::F32 => build_stream::<f32, SAMPLES>(&device, config, tx),
            SampleFormat::F64 => build_stream::<f64, SAMPLES>(&device, config, tx),
            SampleFormat::I16 => build_stream::<i16, SAMPLES>(&device, config, tx),
            SampleFormat::U16 => build_stream::<u16, SAMPLES>(&device, config, tx),
            SampleFormat::I32 => build_stream::<i32, SAMPLES>(&device, config, tx),
            SampleFormat::U32 => build_stream::<u32, SAMPLES>(&device, config, tx),
            _ => bail!("unsupported microphone sample format: {format}"),
        }?;
        stream.play()?;
        Ok(Self {
            sample_rate,
            stream: rx,
            _stream: stream,
        })
    }
}

fn build_stream<T, const N: usize>(
    device: &cpal::Device,
    config: StreamConfig,
    tx: flume::Sender<Samples<N>>,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample,
    f64: FromSample<T>,
{
    let channels = usize::from(config.channels);
    let mut blocks = MonoBlocks::<N>::new();
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            blocks.push(data, channels, |block| {
                // The real-time callback must not wait for the display thread.
                let _ = tx.try_send(Samples(block));
            });
        },
        |error| error!("microphone stream error: {error}"),
        None,
    )
}

/// Downmix complete interleaved frames, then retain partial output blocks across callbacks.
struct MonoBlocks<const N: usize> {
    samples: [f32; N],
    filled: usize,
}
impl<const N: usize> MonoBlocks<N> {
    fn new() -> Self {
        Self {
            samples: [0.0; N],
            filled: 0,
        }
    }
    fn push<T: Sample>(&mut self, input: &[T], channels: usize, mut emit: impl FnMut([f32; N]))
    where
        f64: FromSample<T>,
    {
        for frame in input.chunks_exact(channels) {
            // Mix in f64 and round once, so finite float PCM peaks do not
            // overflow the intermediate sum or erase quieter channels.
            self.samples[self.filled] = (frame
                .iter()
                .map(|&sample| f64::from_sample(sample))
                .sum::<f64>()
                / channels as f64) as f32;
            self.filled += 1;
            if self.filled == N {
                emit(self.samples);
                self.filled = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variable_callbacks_downmix_and_preserve_partial_blocks() {
        let mut blocks = MonoBlocks::<3>::new();
        let mut output = Vec::new();
        blocks.push(&[0.0f32, 1.0, 0.2, 0.4], 2, |b| output.push(b));
        assert!(output.is_empty());
        blocks.push(
            &[0.8f32, 0.4, -1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.2, 0.2],
            2,
            |b| output.push(b),
        );
        assert_eq!(output, [[0.5, 0.3, 0.6], [0.0, 0.0, 1.0]]);
        blocks.push(&[0.4f32, 0.4, 0.6, 0.6], 2, |b| output.push(b));
        assert_eq!(output[2], [0.2, 0.4, 0.6]);
    }
    #[test]
    fn signed_pcm_uses_normalized_float_range() {
        let mut blocks = MonoBlocks::<2>::new();
        let mut output = None;
        blocks.push(&[i16::MIN, 0i16], 1, |b| output = Some(b));
        assert_eq!(output, Some([-1.0, 0.0]));
    }
    #[test]
    fn float_downmix_preserves_peaks_and_avoids_intermediate_overflow() {
        let mut blocks = MonoBlocks::<1>::new();
        let mut output = Vec::new();
        blocks.push(&[4.0f32, 8.0], 2, |b| output.push(b));
        blocks.push(&[f32::MAX, f32::MAX], 2, |b| output.push(b));
        blocks.push(&[33_554_432.0f32, 1.0, -33_554_432.0], 3, |b| {
            output.push(b)
        });
        assert_eq!(output, [[6.0], [f32::MAX], [1.0 / 3.0]]);
    }
}
