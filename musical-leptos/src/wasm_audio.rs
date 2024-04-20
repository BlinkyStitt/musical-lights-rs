use crate::dependent_module;

use log::debug;
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::MediaStream;
use web_sys::{AudioContext, AudioWorkletNode, AudioWorkletNodeOptions};

// Use wasm_audio if you have a single wasm audio processor in your application
// whose samples should be played directly. Ideally, call wasm_audio based on
// user interaction. Otherwise, resume the context on user interaction, so
// playback starts reliably on all browsers.
pub async fn wasm_audio(media_stream: &MediaStream) -> Result<AudioContext, JsValue> {
    let ctx = AudioContext::new()?;

    prepare_wasm_audio(&ctx).await?;

    debug!("audio context: {:?}", ctx);

    let input = ctx.create_media_stream_source(media_stream).unwrap();

    // TODO: pass a process callback to this somehow
    let worklet = wasm_audio_worklet(&ctx)?;

    input.connect_with_audio_node(&worklet)?;

    worklet.connect_with_audio_node(&ctx.destination())?;

    // TODO: i think we need to do something with worklet.port here to get the handled audio samples out

    debug!("audio input: {:?}", input);
    debug!("audio node: {:?}", worklet);

    Ok(ctx)
}

// wasm_audio_node creates an AudioWorkletNode running a wasm audio processor.
// Remember to call prepare_wasm_audio once on your context before calling
// this function.
pub fn wasm_audio_worklet(ctx: &AudioContext) -> Result<AudioWorkletNode, JsValue> {
    let mut audio_worklet_node = AudioWorkletNodeOptions::new();

    // TODO: one example passed wasm_bindgen::memory() here, but I don't think that is needed anymore. it also gave errors
    // TODO: instead of the main module, i think we need a sub-module specifically for audio processing
    let options = audio_worklet_node.processor_options(Some(&js_sys::Array::of2(
        &wasm_bindgen::module(),
        &"foobar".into(),
    )));
    debug!("options: {:?}", options);

    let node = AudioWorkletNode::new_with_options(ctx, "my-wasm-processor", options)?;
    debug!("node: {:?}", node);

    Ok(node)
}

pub async fn prepare_wasm_audio(ctx: &AudioContext) -> Result<(), JsValue> {
    let mod_url = dependent_module!("my-wasm-processor.js")?;
    JsFuture::from(ctx.audio_worklet()?.add_module(&mod_url)?).await?;
    Ok(())
}
