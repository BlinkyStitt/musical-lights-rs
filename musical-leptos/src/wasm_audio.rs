use js_sys::{Float64Array, Reflect};
use musical_lights_core::audio::browser_visual::BrowserSnapshot;
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{JsCast, JsValue, closure::Closure, prelude::wasm_bindgen};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AudioContext, AudioContextOptions, AudioWorkletNode, MediaStream, MediaStreamAudioSourceNode,
    MediaStreamConstraints, MediaStreamTrack, MediaTrackConstraints, MessageEvent,
};

#[wasm_bindgen(module = "/src/audio_setup.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = prepareProcessor)]
    async fn prepare_processor(
        context: &AudioContext,
        stream: &MediaStream,
        channel: u32,
        reduced: bool,
    ) -> Result<AudioWorkletNode, JsValue>;
    #[wasm_bindgen(js_name = captureStatus)]
    fn capture_status(node: &AudioWorkletNode) -> String;
    #[wasm_bindgen(catch, js_name = saveCalibration)]
    fn save_calibration(node: &AudioWorkletNode, pascals: f64) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = releaseProcessor)]
    fn release_processor(node: &AudioWorkletNode);
    #[wasm_bindgen(js_name = canCalibrate)]
    fn can_calibrate(node: &AudioWorkletNode) -> bool;
}

// Keep the frequent numeric frame inline; avoid one extra allocation per refresh.
#[allow(clippy::large_enum_variant)]
pub enum AudioUpdate {
    Frame {
        snapshot: BrowserSnapshot,
        clipped: u64,
    },
    Status(String),
    Error(String),
}

#[derive(Clone)]
pub struct AudioSession {
    resources: Rc<RefCell<Option<AudioResources>>>,
}
struct AudioResources {
    context: AudioContext,
    stream: Option<MediaStream>,
    input: Option<MediaStreamAudioSourceNode>,
    worklet: Option<AudioWorkletNode>,
    callback: Option<Closure<dyn FnMut(MessageEvent)>>,
    reduced_motion: bool,
}

impl AudioSession {
    pub fn new() -> Result<Self, JsValue> {
        let options = AudioContextOptions::new();
        options.set_sample_rate(48_000.0);
        let context = AudioContext::new_with_context_options(&options)?;
        if context.sample_rate() != 48_000.0 {
            let _ = context.close();
            return Err(JsValue::from_str(
                "The loudness model requires a 48000 Hz audio context",
            ));
        }
        Ok(Self {
            resources: Rc::new(RefCell::new(Some(AudioResources {
                context,
                stream: None,
                input: None,
                worklet: None,
                callback: None,
                reduced_motion: false,
            }))),
        })
    }
    pub fn sample_rate(&self) -> f32 {
        48_000.0
    }
    pub fn time(&self) -> f64 {
        self.resources
            .borrow()
            .as_ref()
            .map_or(0.0, |r| r.context.current_time())
    }

    pub async fn start(
        &self,
        channel: u32,
        mut on_update: impl FnMut(AudioUpdate) + 'static,
    ) -> Result<(), JsValue> {
        let context = self
            .resources
            .borrow()
            .as_ref()
            .ok_or_else(closed_session)?
            .context
            .clone();
        // Build the complete graph before its sample clock starts. Connecting
        // nodes on a running context can interrupt the first render quanta.
        JsFuture::from(context.suspend()?).await?;
        if self.resources.borrow().is_none() {
            return Err(closed_session());
        }
        let audio = MediaTrackConstraints::new();
        audio.set_auto_gain_control(&JsValue::FALSE);
        audio.set_echo_cancellation(&JsValue::FALSE);
        audio.set_noise_suppression(&JsValue::FALSE);
        let constraints = MediaStreamConstraints::new();
        constraints.set_audio(&audio);
        let window =
            web_sys::window().ok_or_else(|| JsValue::from_str("Browser window is unavailable"))?;
        let stream = JsFuture::from(
            window
                .navigator()
                .media_devices()?
                .get_user_media_with_constraints(&constraints)?,
        )
        .await?
        .dyn_into::<MediaStream>()?;
        {
            let mut guard = self.resources.borrow_mut();
            let Some(resources) = guard.as_mut() else {
                stop_tracks(&stream);
                return Err(closed_session());
            };
            // MediaStream.clone() creates new tracks. Clone the JS reference instead.
            resources.stream = Some(Clone::clone(&stream));
        }
        let reduced = self
            .resources
            .borrow()
            .as_ref()
            .ok_or_else(closed_session)?
            .reduced_motion;
        let worklet = prepare_processor(&context, &stream, channel, reduced).await?;
        let port = worklet.port()?;
        let callback_port = port.clone();
        let callback_node = worklet.clone();
        let weak = Rc::downgrade(&self.resources);
        let ack = js_sys::Object::new();
        Reflect::set(&ack, &"type".into(), &"ack".into())?;
        let callback = Closure::new(move |event: MessageEvent| {
            let Some(resources) = weak.upgrade() else {
                return;
            };
            if resources.borrow().is_none() {
                return;
            }
            let data = event.data();
            let kind = Reflect::get(&data, &"type".into())
                .ok()
                .and_then(|v| v.as_string());
            match kind.as_deref() {
                Some("frame") => {
                    let parsed = Reflect::get(&data, &"state".into())
                        .ok()
                        .and_then(|v| v.dyn_into::<Float64Array>().ok())
                        .and_then(|v| BrowserSnapshot::from_transport(&v.to_vec()));
                    if let Some(snapshot) = parsed {
                        let clipped = Reflect::get(&data, &"clipped".into())
                            .ok()
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0) as u64;
                        on_update(AudioUpdate::Frame { snapshot, clipped });
                    } else {
                        on_update(AudioUpdate::Error("Invalid audio display state".into()));
                    }
                    if let Some(value) = Reflect::get(&data, &"calibration".into())
                        .ok()
                        .and_then(|v| v.as_f64())
                        .filter(|v| *v > 0.0)
                    {
                        match save_calibration(&callback_node, value) {
                            Ok(()) => {
                                on_update(AudioUpdate::Status(capture_status(&callback_node)))
                            }
                            Err(error) => {
                                on_update(AudioUpdate::Error(format!("Calibration: {error:?}")))
                            }
                        }
                    }
                    let _ = callback_port.post_message(&ack);
                }
                Some("error") => {
                    let message = Reflect::get(&data, &"message".into())
                        .ok()
                        .and_then(|v| v.as_string())
                        .unwrap_or_else(|| "Audio analysis failed".into());
                    on_update(AudioUpdate::Error(message));
                }
                _ => on_update(AudioUpdate::Error("Unknown audio processor message".into())),
            }
        });
        let reduced = {
            let mut guard = self.resources.borrow_mut();
            let Some(resources) = guard.as_mut() else {
                release_processor(&worklet);
                return Err(closed_session());
            };
            resources.input = Some(context.create_media_stream_source(&stream)?);
            port.set_onmessage(Some(callback.as_ref().unchecked_ref()));
            resources
                .input
                .as_ref()
                .unwrap()
                .connect_with_audio_node(&worklet)?;
            worklet.connect_with_audio_node(&context.destination())?;
            resources.worklet = Some(worklet);
            resources.callback = Some(callback);
            resources.reduced_motion
        };
        self.set_reduced_motion(reduced);
        JsFuture::from(context.resume()?).await?;
        if self.resources.borrow().is_none() {
            return Err(closed_session());
        }
        Ok(())
    }

    pub fn status(&self) -> String {
        self.resources
            .borrow()
            .as_ref()
            .and_then(|r| r.worklet.as_ref())
            .map_or_else(|| "Uncalibrated".into(), capture_status)
    }
    pub fn set_reduced_motion(&self, reduced: bool) {
        let worklet = {
            let mut guard = self.resources.borrow_mut();
            let Some(resources) = guard.as_mut() else {
                return;
            };
            resources.reduced_motion = reduced;
            resources.worklet.clone()
        };
        if let Some(worklet) = worklet {
            let message = js_sys::Object::new();
            let _ = Reflect::set(&message, &"type".into(), &"motion".into());
            let _ = Reflect::set(&message, &"reduced".into(), &reduced.into());
            if let Ok(port) = worklet.port() {
                let _ = port.post_message(&message);
            }
        }
    }
    pub fn calibrate(&self, db_spl: f64) -> Result<(), JsValue> {
        if !db_spl.is_finite() {
            return Err(JsValue::from_str("Enter a finite reference level"));
        }
        let worklet = self
            .resources
            .borrow()
            .as_ref()
            .and_then(|r| r.worklet.clone())
            .ok_or_else(closed_session)?;
        if !can_calibrate(&worklet) {
            return Err(JsValue::from_str(
                "Calibration requires verified fixed capture settings",
            ));
        }
        let message = js_sys::Object::new();
        Reflect::set(&message, &"type".into(), &"calibrate".into())?;
        Reflect::set(&message, &"dbSpl".into(), &db_spl.into())?;
        worklet.port()?.post_message(&message)
    }
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
            release_processor(worklet);
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
