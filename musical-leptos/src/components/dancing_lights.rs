use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleRate, Stream,
};
use leptos::*;
use musical_lights_core::{
    audio::{
        AWeighting, AggregatedAmplitudes, AggregatedAmplitudesBuilder, AudioBuffer,
        BarkScaleBuilder, ExponentialScaleBuilder, Samples, FFT,
    },
    lights::{DancingLights, Gradient},
    logging::{error, info, trace},
    windows::HanningWindow,
};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{AudioContext, MediaStream, MediaStreamConstraints};

use crate::wasm_audio::wasm_audio;

const MIC_SAMPLES: usize = 512;
const FFT_INPUTS: usize = 2048;
const NUM_CHANNELS: usize = 120;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

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
pub fn DancingLights() -> impl IntoView {
    let once = create_resource(
        || (),
        |_| async move {
            let media_stream = load_media_stream()
                .await
                .map_err(|x| format!("media stream error: {:?}", x))?;

            let media_stream_id = media_stream.id();

            info!("active media stream: {:?}", media_stream_id);

            let audio_ctx = wasm_audio(Box::new(move |buf| {
                // TODO: actually process it
                info!("audio buffer: {:?}", buf);
                true
            }))
            .await
            .map_err(|x| format!("audio_ctx error: {:?}", x))?;

            info!("audio context: {:?}", audio_ctx);

            // TODO: we probably need to call `audio_ctx.resume()` somewhere

            Ok::<_, String>(media_stream_id)
        },
    );

    // TODO: i think we have error handling elsewhere. use it
    move || match once() {
        None => view! { <div>"Waiting for Audio Input..."</div> }.into_view(),
        Some(Ok(media_stream_id)) => view! { <div>{media_stream_id}</div> }.into_view(),
        Some(Err(err)) => view! { <div>Error: {err}</div> }.into_view(),
    }
}
