//! TODO: refactor this to use the types in microphone.rs

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleRate, Stream,
};
use embassy_sync::{
    blocking_mutex::raw::ThreadModeRawMutex,
    channel::{Channel, Sender},
};
use log::{error, info, trace};
use musical_lights_core::microphone::Samples;

// i wanted this to be generic, but that's making things complicated
const SAMPLES: usize = 512;

/// TODO: i think this should be a trait
pub struct MicrophoneStream {
    pub sample_rate: SampleRate,
    pub stream: flume::Receiver<Samples<SAMPLES>>,

    /// TODO: i think dropping this stops recording
    _stream: Stream,
}

impl MicrophoneStream {
    pub fn try_new() -> anyhow::Result<Self> {
        let host = cpal::default_host();

        // TODO: host.input_devices()?.find(|x| x.name().map(|y| y == opt.device).unwrap_or(false))
        let device = host
            .default_input_device()
            .expect("Failed to get default input device");

        let config = device.default_input_config().unwrap();

        let err_fn = move |err| {
            error!("an error occurred on stream: {}", err);
        };

        // samples per second
        let sample_rate = config.sample_rate();
        info!("sample rate = {}", sample_rate.0);

        let buffer_size = config.buffer_size();
        info!("buffer size = {:?}", buffer_size);

        // TODO: what capacity channel? i think we want to discard old samples if we are lagging, so probably a watch
        let (tx, rx) = flume::bounded(2);

        let stream = match config.sample_format() {
            // cpal::SampleFormat::I8 => device.build_input_stream(
            //     &config.into(),
            //     err_fn,
            //     None,
            // )?,
            // cpal::SampleFormat::I16 => device.build_input_stream(
            //     &config.into(),
            //     move |data, _: &_| write_input_data::<i16>(data, &audio_processing),
            //     err_fn,
            //     None,
            // )?,
            // cpal::SampleFormat::I32 => device.build_input_stream(
            //     &config.into(),
            //     move |data, _: &_| write_input_data::<i32>(data, &audio_processing),
            //     err_fn,
            //     None,
            // )?,
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.into(),
                move |data, _: &_| Self::send_mic_data(data, &tx),
                err_fn,
                None,
            )?,
            sample_format => {
                return Err(anyhow::anyhow!(
                    "Unsupported sample format '{sample_format}'"
                ))
            }
        };

        stream.play()?;

        Ok(Self {
            _stream: stream,
            sample_rate,
            stream: rx,
        })
    }

    fn send_mic_data(samples: &[f32], tx: &flume::Sender<Samples<SAMPLES>>) {
        trace!("heard {} samples", samples.len());

        debug_assert_eq!(samples.len(), SAMPLES);

        let samples: [f32; SAMPLES] = samples[..SAMPLES].try_into().unwrap();

        tx.send(Samples(samples)).unwrap();

        trace!("sent {} samples", samples.len());
    }
}
