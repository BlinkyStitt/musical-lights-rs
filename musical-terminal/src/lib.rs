use cpal::{
    SampleRate, Stream, StreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use musical_lights_core::audio::Samples;
use musical_lights_core::logging::{error, info, trace};

/// TODO: i think this should be a trait. then we could have the i2s mic on embedded and the cpal input use mo
pub struct MicrophoneStream<const SAMPLES: usize> {
    pub sample_rate: SampleRate,
    pub stream: flume::Receiver<Samples<SAMPLES>>,

    /// TODO: i think dropping this stops recording
    _stream: Stream,
}

impl<const SAMPLES: usize> MicrophoneStream<SAMPLES> {
    pub fn try_new(sample_rate: u32) -> anyhow::Result<Self> {
        let sample_rate = SampleRate(sample_rate);

        let host = cpal::default_host();

        for device in host.input_devices()? {
            info!("host input device: {:?}", device.name());
        }

        let device = host
            .input_devices()?
            .find(|x| x.name() == Ok("Loopback Audio".to_string()))
            .or_else(|| {
                host.input_devices()
                    .unwrap()
                    .find(|x| x.name() == Ok("MacBook Pro Microphone".to_string()))
            })
            .unwrap_or_else(|| host.default_input_device().unwrap());

        // let mut config = device.default_input_config().unwrap();

        let config = StreamConfig {
            channels: 1,
            sample_rate,
            buffer_size: cpal::BufferSize::Fixed(SAMPLES as u32),
        };

        let err_fn = move |err| {
            error!("an error occurred on stream: {err:?}");
        };

        info!("sample rate = {:?}", config.sample_rate);
        info!("buffer size = {:?}", config.buffer_size);

        // TODO: what capacity channel? i think we want to discard old samples if we are lagging, so probably a watch
        let (tx, rx) = flume::bounded(2);

        let stream = device.build_input_stream(
            &config,
            move |data, _: &_| Self::send_mic_data(data, &tx),
            err_fn,
            None,
        )?;

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
