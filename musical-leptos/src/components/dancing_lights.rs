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
use web_sys::{AudioContext, HtmlAudioElement, MediaStream, MediaStreamConstraints, MessageEvent};

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
    // TODO: do this on button click
    let (listen, set_listen) = create_signal(false);

    let (audio, set_audio) = create_signal(0.0);

    // TODO: this is wrong. this runs immediatly, not on first click. why?
    let start_listening = create_resource(listen, move |x| async move {
        if !x {
            return Ok(None);
        }

        let media_stream = load_media_stream()
            .await
            .map_err(|x| format!("media stream error: {:?}", x))?;

        let media_stream_id = media_stream.id();

        info!("active media stream: {:?}", media_stream_id);

        let onmessage_callback = Closure::new(move |x: MessageEvent| {
            // TODO: this seems fragile. how do we be sure of the data type
            // TODO: this will actually be a vec of 120 f32s when we are done
            let data = x.data().as_f64().unwrap();
            set_audio(data);
        });

        let audio_ctx = wasm_audio(&media_stream, onmessage_callback)
            .await
            .map_err(|x| format!("audio_ctx error: {:?}", x))?;

        info!("audio context: {:?}", audio_ctx);

        // // TODO: do we need this? does it need to be spawned?
        // let promise = audio_ctx.resume().unwrap();
        // let _ = wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();

        // TODO: what do we do with the receiver?

        Ok::<_, String>(Some(media_stream_id))
    });

    view! {
        // TODO: i think we have an error handler helper elsewhere
        { move || match start_listening() {
            None | Some(Ok(None)) => view! {
                <button
                    on:click= move |_| {
                        set_listen(true)
                    }
                >
                    Start Listening
                </button>
            }.into_view(),
            Some(Ok(Some(media_stream_id))) => view! {
                <button
                    on:click= move |_| {
                        // set_listen(false)

                        // TODO: set_listen to false. once we figure out how to turn off this media_stream
                    }
                >
                    Now listening to {media_stream_id}
                </button>

                <pre>{audio}</pre>
            }.into_view(),
            Some(Err(err)) => view! { <div>Error: {err}</div> }.into_view(),
        }}

    }
}
