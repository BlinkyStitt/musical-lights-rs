use crate::dependent_module;

use log::debug;
use log::info;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::MediaStream;
use web_sys::{AudioContext, AudioWorkletNode, AudioWorkletNodeOptions};

type WasmAudioProcessorFn = Box<dyn FnMut(&mut [f32]) -> bool>;

#[wasm_bindgen]
pub struct WasmAudioProcessor(WasmAudioProcessorFn);

#[wasm_bindgen]
impl WasmAudioProcessor {
    pub fn process(&mut self, buf: &mut [f32]) -> bool {
        // TODO: instead of calling an arbitrary function, should we write something more specific here?
        self.0(buf)
    }
    pub fn pack(self) -> usize {
        Box::into_raw(Box::new(self)) as usize
    }
    pub unsafe fn unpack(val: usize) -> Self {
        *Box::from_raw(val as *mut _)
    }
}

// Use wasm_audio if you have a single wasm audio processor in your application
// whose samples should be played directly. Ideally, call wasm_audio based on
// user interaction. Otherwise, resume the context on user interaction, so
// playback starts reliably on all browsers.
pub async fn wasm_audio(
    media_stream: &MediaStream,
    process: WasmAudioProcessorFn,
) -> Result<AudioContext, JsValue> {
    let ctx = AudioContext::new()?;

    prepare_wasm_audio(&ctx).await?;

    info!("audio context: {:?}", ctx);

    // TODO: i think this should take the MediaStream as input. otherwise we aren't actually connecting them!
    // TODO: just do a ctx.createOscillator() while testing?
    let input = ctx.create_media_stream_source(media_stream).unwrap();

    // TODO: don't we need to connect to the input somehow?

    let worklet = wasm_audio_worklet(&ctx, process)?;

    input.connect_with_audio_node(&worklet)?;

    worklet.connect_with_audio_node(&ctx.destination())?;

    info!("audio input: {:?}", input);
    info!("audio node: {:?}", worklet);

    Ok(ctx)
}

// wasm_audio_node creates an AudioWorkletNode running a wasm audio processor.
// Remember to call prepare_wasm_audio once on your context before calling
// this function.
pub fn wasm_audio_worklet(
    ctx: &AudioContext,
    process: WasmAudioProcessorFn,
) -> Result<AudioWorkletNode, JsValue> {
    let mut audio_worklet_node = AudioWorkletNodeOptions::new();

    // TODO: one example passed wasm_bindgen::memory() here, but I don't think that is needed anymore
    let options = audio_worklet_node.processor_options(Some(&js_sys::Array::of2(
        &wasm_bindgen::module(),
        &WasmAudioProcessor(process).pack().into(),
    )));
    debug!("options: {:?}", options);

    let node = AudioWorkletNode::new_with_options(ctx, "WasmProcessor", options)?;
    info!("node: {:?}", node);

    Ok(node)
}

pub async fn prepare_wasm_audio(ctx: &AudioContext) -> Result<(), JsValue> {
    let mod_url = dependent_module!("audio_worklet.js")?;
    JsFuture::from(ctx.audio_worklet()?.add_module(&mod_url)?).await?;
    Ok(())
}
