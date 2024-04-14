//! TODO: refactor this to use the types in microphone.rs

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleRate, Stream,
};
use leptos::*;
use musical_lights_core::audio::Samples;
use musical_lights_core::logging::{error, info, trace};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{MediaStream, MediaStreamConstraints};

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

    fn send_mic_data(samples: &[f32], tx: &flume::Sender<Samples<SAMPLES>>) {
        trace!("heard {} samples", samples.len());

        debug_assert_eq!(samples.len(), SAMPLES);

        let samples: [f32; SAMPLES] = samples[..SAMPLES].try_into().unwrap();

        tx.send(Samples(samples)).unwrap();

        trace!("sent {} samples", samples.len());
    }
}

/// TODO: what type should we return on this?
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

/// Prompt the user for their microphone
#[component]
pub fn Microphone() -> impl IntoView {
    let once = create_resource(|| (), |_| async move {
        load_media_stream().await.map(|x| format!("{:?}", x)).map_err(|x| format!("{:?}", x))
    });

    {move || match once.get() {
        None => view! { <div>"Waiting for Microphone..."</div> }.into_view(),
        Some(Ok(data)) => view! { <div>{data}</div> }.into_view(),
        Some(Err(err)) => view! { <div>Error: {err}</div> }.into_view(),
    }}
}
