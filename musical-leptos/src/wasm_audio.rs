use js_sys::{Array, Float32Array};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AudioContext, AudioWorkletNode, Blob, BlobPropertyBag, MediaStream, MediaStreamAudioSourceNode,
    MediaStreamConstraints, MediaStreamTrack, MessageEvent, Url,
};

/// A view owns the session while asynchronous setup can also hold a handle.
#[derive(Clone)]
pub struct AudioSession {
    resources: Rc<RefCell<Option<AudioResources>>>,
}

/// Dropping these resources also releases a partially initialized session.
struct AudioResources {
    context: AudioContext,
    stream: Option<MediaStream>,
    input: Option<MediaStreamAudioSourceNode>,
    worklet: Option<AudioWorkletNode>,
    callback: Option<Closure<dyn FnMut(MessageEvent)>>,
}

impl AudioSession {
    /// Call directly from a user gesture so the browser can start audio.
    pub fn new() -> Result<Self, JsValue> {
        Ok(Self {
            resources: Rc::new(RefCell::new(Some(AudioResources {
                context: AudioContext::new()?,
                stream: None,
                input: None,
                worklet: None,
                callback: None,
            }))),
        })
    }

    pub fn sample_rate(&self) -> f32 {
        self.resources
            .borrow()
            .as_ref()
            .expect("open audio session")
            .context
            .sample_rate()
    }

    pub async fn start(
        &self,
        mut on_samples: impl FnMut(Option<Vec<f32>>) + 'static,
    ) -> Result<(), JsValue> {
        let context = self
            .resources
            .borrow()
            .as_ref()
            .ok_or_else(closed_session)?
            .context
            .clone();
        JsFuture::from(context.resume()?).await?;
        if self.resources.borrow().is_none() {
            return Err(closed_session());
        }
        let constraints = MediaStreamConstraints::new();
        constraints.set_audio(&JsValue::TRUE);
        let window =
            web_sys::window().ok_or_else(|| JsValue::from_str("Browser window is unavailable"))?;
        let stream = JsFuture::from(
            window
                .navigator()
                .media_devices()?
                .get_user_media_with_constraints(&constraints)?,
        )
        .await?;
        let stream = stream.dyn_into::<MediaStream>()?;
        {
            let mut resources = self.resources.borrow_mut();
            let Some(resources) = resources.as_mut() else {
                stop_tracks(&stream);
                return Err(closed_session());
            };
            resources.stream = Some(stream);
        }
        let options = BlobPropertyBag::new();
        options.set_type("text/javascript");
        let blob = Blob::new_with_str_sequence_and_options(
            &Array::of1(&JsValue::from_str(include_str!("my-wasm-processor.js"))),
            &options,
        )?;
        let url = Url::create_object_url_with_blob(&blob)?;
        let loaded =
            async { JsFuture::from(context.audio_worklet()?.add_module(&url)?).await }.await;
        Url::revoke_object_url(&url)?;
        loaded?;
        let mut resources = self.resources.borrow_mut();
        let resources = resources.as_mut().ok_or_else(closed_session)?;
        resources.input =
            Some(context.create_media_stream_source(resources.stream.as_ref().unwrap())?);
        resources.worklet = Some(AudioWorkletNode::new(&context, "my-wasm-processor")?);
        let callback = Closure::new(move |event: MessageEvent| {
            let data = event.data();
            if data.is_null() || data.is_undefined() {
                on_samples(None);
            } else if let Ok(data) = data.dyn_into::<Float32Array>() {
                on_samples(Some(data.to_vec()));
            }
        });
        let worklet = resources.worklet.as_ref().unwrap();
        worklet
            .port()?
            .set_onmessage(Some(callback.as_ref().unchecked_ref()));
        resources.callback = Some(callback);
        resources
            .input
            .as_ref()
            .unwrap()
            .connect_with_audio_node(worklet)?;
        // The worklet writes silence to the output, so the microphone does not feed back.
        worklet.connect_with_audio_node(&context.destination())?;
        Ok(())
    }

    /// Close now, even while the browser permission request is pending.
    pub fn stop(&self) {
        self.resources.borrow_mut().take();
    }
}

fn closed_session() -> JsValue {
    JsValue::from_str("Audio session has closed")
}

fn stop_tracks(stream: &MediaStream) {
    for track in stream.get_tracks().iter() {
        if let Ok(track) = track.dyn_into::<MediaStreamTrack>() {
            track.stop();
        }
    }
}

impl Drop for AudioResources {
    fn drop(&mut self) {
        if let Some(worklet) = &self.worklet {
            if let Ok(port) = worklet.port() {
                port.set_onmessage(None);
                port.close();
            }
            let _ = worklet.disconnect();
        }
        if let Some(input) = &self.input {
            let _ = input.disconnect();
        }
        if let Some(stream) = &self.stream {
            stop_tracks(stream);
        }
        let _ = self.context.close();
    }
}
