use cpal::{
    SampleRate, Stream, StreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use musical_lights_core::audio::Samples;
use musical_lights_core::logging::{error, info, trace};

/// This is set by Apple. this should probably be a setting.
// const SAMPLES: usize = 480;

/// TODO: i think this should be a trait. then we could have the i2s mic on embedded and the cpal input use mo
pub struct MicrophoneStream<const SAMPLES: usize> {
    pub sample_rate: SampleRate,
    pub stream: flume::Receiver<Samples<SAMPLES>>,

    /// TODO: i think dropping this stops recording
    _stream: Stream,
}

impl<const SAMPLES: usize> MicrophoneStream<SAMPLES> {
    pub fn try_new() -> anyhow::Result<Self> {
        let host = cpal::default_host();

        // TODO: host.input_devices()?.find(|x| x.name().map(|y| y == opt.device).unwrap_or(false))
        let device = host
            .default_input_device()
            .expect("Failed to get default input device");

        // let mut config = device.default_input_config().unwrap();

        let sample_rate = SampleRate(48_000);

        let config = StreamConfig {
            channels: 1,
            sample_rate,
            buffer_size: cpal::BufferSize::Fixed(SAMPLES as u32),
        };

        let err_fn = move |err| {
            error!("an error occurred on stream: {err:?}");
        };

        // // samples per second
        // let sample_rate = config.sample_rate();
        // info!("sample rate = {}", sample_rate.0);

        // // TODO: how do we set this size? we want 48kHz and 480 samples for 100FPS. its doing 48kHz and 512 samples
        // let buffer_size = config.buffer_size();
        // info!("buffer size = {buffer_size:?}");

        // TODO: what capacity channel? i think we want to discard old samples if we are lagging, so probably a watch
        let (tx, rx) = flume::bounded(2);

        let stream = device
            .build_input_stream(
                &config,
                move |data, _: &_| Self::send_mic_data(data, &tx),
                err_fn,
                None,
            )
            .unwrap();

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

        let samples: [f32; SAMPLES] = samples[..].try_into().unwrap();

        tx.send(Samples(samples)).unwrap();

        trace!("sent {} samples", samples.len());
    }
}
