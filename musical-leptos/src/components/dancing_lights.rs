use js_sys::Float64Array;
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

// #[derive(Copy, Clone, Debug, PartialEq, Eq)]
// struct AudioOutput {
//     signal: ReadSignal<f32>
// }

/// TODO: this should be done in the audio worklet, but its easier to put here for now
struct DancingLightsProcessor {
    signal: WriteSignal<Vec<f32>>,
}

impl DancingLightsProcessor {
    fn new(signal: WriteSignal<Vec<f32>>) -> Self {
        Self { signal }
    }

    fn process(&self, inputs: Vec<f32>) {
        // TODO: do some audio processing on the inputs to turn it into 120 outputs
        // TODO: instead of hard coding 120, use a generic

        // self.signal(inputs);
        info!("inputs: {:?}", inputs);
    }
}

/// Prompt the user for their microphone
#[component]
pub fn DancingLights() -> impl IntoView {
    // TODO: do this on button click
    let (listen, set_listen) = create_signal(false);

    // TODO: this needs to be a vec of signals
    let (audio, set_audio) = create_signal(vec![]);

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
            let data = x.data();

            let data = Float64Array::new(&data);

            let data = data.to_vec();

            // TODO: actual audio processing
            // TODO: this will actually be a vec of 120 f32s when we are done

            trace!("data: {:#?}", data);

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

                <ol>
                    // <For
                    //     each={move || audio.get().into_iter().enumerate()}
                    //     key=|(i, _val)| *i
                    //     let:data
                    // >
                    //     <li>{data.1}</li>
                    // </For>
                    {audio().into_iter().enumerate().map(|(i, x)| audio_list_item(i, x)).collect_view()}
                </ol>
            }.into_view(),
            Some(Err(err)) => view! { <div>Error: {err}</div> }.into_view(),
        }}

    }
}

/// TODO: i think this should be a component
pub fn audio_list_item(i: usize, x: f64) -> impl IntoView {
    // TODO: pick a color based on the index

    let x = (x * 10000.0) as u64;

    view! {
        <li>{x}</li>
    }
}
