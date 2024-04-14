use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleRate, Stream,
};
use leptos::*;
use musical_lights_core::{
    audio::{
        AWeighting, AggregatedAmplitudes, AggregatedAmplitudesBuilder, AudioBuffer,
        ExponentialScaleBuilder, Samples, FFT,
    },
    lights::{DancingLights, Gradient},
    logging::{error, info, trace},
    windows::HanningWindow,
};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{MediaStream, MediaStreamConstraints};

const MIC_SAMPLES: usize = 512;
const FFT_INPUTS: usize = 2048;
const NUM_CHANNELS: usize = 120;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

/// TODO: i think this should be a trait
pub struct MicrophoneStream {
    pub sample_rate: SampleRate,
    pub stream: flume::Receiver<Samples<MIC_SAMPLES>>,

    /// TODO: i think dropping this stops recording
    _stream: Stream,
}

impl MicrophoneStream {
    // TODO: what should the error type be?
    pub fn try_new() -> Result<Self, String> {
        let host = cpal::default_host();

        // TODO: let the user pick?
        // TODO: host.input_devices()?.find(|x| x.name().map(|y| y == opt.device).unwrap_or(false))
        let device = host
            .default_input_device()
            .expect("Failed to get default input device");

        let config = device.default_input_config().unwrap();

        let err_fn = move |err| {
            error!("an error occurred on stream: {:?}", err);
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
            cpal::SampleFormat::F32 => device
                .build_input_stream(
                    &config.into(),
                    move |data, _: &_| Self::send_mic_data(data, &tx),
                    err_fn,
                    None,
                )
                .map_err(|err| format!("{}", err))?,
            sample_format => return Err("Unsupported sample format '{sample_format}'".to_string()),
        };

        stream.play().unwrap();

        Ok(Self {
            _stream: stream,
            sample_rate,
            stream: rx,
        })
    }

    fn send_mic_data(samples: &[f32], tx: &flume::Sender<Samples<MIC_SAMPLES>>) {
        trace!("heard {} samples", samples.len());

        debug_assert_eq!(samples.len(), MIC_SAMPLES);

        let samples: [f32; MIC_SAMPLES] = samples[..MIC_SAMPLES].try_into().unwrap();

        tx.send(Samples(samples)).unwrap();

        trace!("sent {} samples", samples.len());
    }
}

async fn load_media_stream() -> Result<MediaStream, JsValue> {
    let navigator = window().navigator();

    let mut constraints = MediaStreamConstraints::new();
    constraints.audio(&JsValue::from(true));

    let promise = navigator
        .media_devices()
        .unwrap()
        .get_user_media_with_constraints(&constraints)
        .unwrap();

    let f = wasm_bindgen_futures::JsFuture::from(promise);

    let stream: MediaStream = f.await?.unchecked_into();

    Ok(stream)
}

async fn audio_task(
    mic_stream: MicrophoneStream,
    mut audio_buffer: AudioBuffer<MIC_SAMPLES, FFT_INPUTS>,
    fft: FFT<FFT_INPUTS, FFT_OUTPUTS>,
    scale_builder: ExponentialScaleBuilder<FFT_OUTPUTS, NUM_CHANNELS>,
    tx_loudness: flume::Sender<AggregatedAmplitudes<NUM_CHANNELS>>,
) {
    while let Ok(samples) = mic_stream.stream.recv_async().await {
        audio_buffer.push_samples(samples);

        let samples = audio_buffer.samples();

        let amplitudes = fft.weighted_amplitudes(samples);

        let loudness = scale_builder.build(amplitudes).0;

        // TODO: shazam
        // TODO: beat detection
        // TODO: peak detection

        tx_loudness.send_async(loudness).await.unwrap();
    }

    info!("audio task complete");
}

/// Prompt the user for their microphone
#[component]
pub fn DancingLights() -> impl IntoView {
    let once = create_resource(
        || (),
        |_| async move {
            let media_stream = load_media_stream().await.map_err(|x| format!("{:?}", x))?;

            // TODO: set up more things here. i think we need to spawn a task for channels

            // let (loudness_tx, loudness_rx) = flume::bounded(2);

            let mic_stream = MicrophoneStream::try_new().unwrap();

            let audio_buffer = AudioBuffer::<MIC_SAMPLES, FFT_INPUTS>::new();

            let sample_rate = mic_stream.sample_rate.0 as f32;

            // TODO: a-weighting probably isn't what we want. also, our microphone frequency response is definitely not flat
            // let weighting = AWeighting::new(sample_rate);

            // let fft = FFT::new_with_window_and_weighting::<HanningWindow<FFT_INPUTS>, _>(weighting);

            // TODO: have multiple scales and compare them. is "scale" the right term?
            // let bark_scale_builder = BarkScaleBuilder::new(sample_rate);
            // TODO: I'm never seeing anything in bucket 0
            // let equal_tempered_scale_builder =
            //     ExponentialScaleBuilder::new(0.0, 20_000.0, sample_rate);

            // let audio_f = audio_task(
            //     mic_stream,
            //     audio_buffer,
            //     fft,
            //     equal_tempered_scale_builder,
            //     loudness_tx,
            // );

            // TODO: how do we spawn the audio task? in a worker?

            Ok::<_, String>(format!("under construction. {:?}", &media_stream))
        },
    );

    {
        move || match once() {
            None => view! { <div>"Waiting for Audio Input..."</div> }.into_view(),
            Some(Ok(data)) => view! { <div>{data}</div> }.into_view(),
            Some(Err(err)) => view! { <div>Error: {err}</div> }.into_view(),
        }
    }
}
