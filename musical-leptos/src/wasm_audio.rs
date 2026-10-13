use js_sys::{Float64Array, Reflect};
use musical_lights_core::audio::presentation::LoudnessSnapshot;
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{JsCast, JsValue, closure::Closure, prelude::wasm_bindgen};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AudioContext, AudioWorkletNode, MediaStream, MediaStreamAudioSourceNode, MediaStreamTrack,
    MessageEvent,
};

#[wasm_bindgen(module = "/src/audio_setup.js")]
extern "C" {
    #[wasm_bindgen(js_name = retireAudioContext)]
    fn retire_audio_context(context: &AudioContext);
    type InputControls;
    #[wasm_bindgen(constructor)]
    fn new(card: &web_sys::HtmlElement, on_change: &js_sys::Function) -> InputControls;
    #[wasm_bindgen(method)]
    fn close(this: &InputControls);
    #[wasm_bindgen(catch, js_name = suspendForStartup)]
    fn suspend_for_startup(context: &AudioContext) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(catch, js_name = acquireInput)]
    async fn acquire_input(context: &AudioContext, channel: u32) -> Result<MediaStream, JsValue>;
    #[wasm_bindgen(js_name = inputIsGenerated)]
    fn input_is_generated(stream: &MediaStream) -> bool;
    #[wasm_bindgen(js_name = releaseInput)]
    fn release_input(stream: &MediaStream);
    #[wasm_bindgen(catch, js_name = prepareProcessor)]
    async fn prepare_processor(
        context: &AudioContext,
        stream: &MediaStream,
        channel: u32,
        reduced: bool,
    ) -> Result<AudioWorkletNode, JsValue>;
    #[wasm_bindgen(js_name = forgetCalibration)]
    fn forget_calibration(node: &AudioWorkletNode);
    #[wasm_bindgen(js_name = captureStatus)]
    fn capture_status(node: &AudioWorkletNode) -> String;
    #[wasm_bindgen(catch, js_name = saveCalibration)]
    fn save_calibration(node: &AudioWorkletNode, pascals: f64) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = releaseProcessor)]
    fn release_processor(node: &AudioWorkletNode);
    #[wasm_bindgen(js_name = canCalibrate)]
    fn can_calibrate(node: &AudioWorkletNode) -> bool;
    #[wasm_bindgen(js_name = isCurrentProcessorMessage)]
    fn is_current_processor_message(node: &AudioWorkletNode, data: &JsValue) -> bool;
}

#[wasm_bindgen(module = "/src/audio_controls.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = createAudioContext)]
    fn create_audio_context() -> Result<AudioContext, JsValue>;
}

pub struct InputControlSession {
    controls: InputControls,
    _callback: Closure<dyn FnMut(String, bool)>,
}
impl InputControlSession {
    pub fn new(card: &web_sys::HtmlElement, callback: impl FnMut(String, bool) + 'static) -> Self {
        let callback = Closure::new(callback);
        Self {
            controls: InputControls::new(card, callback.as_ref().unchecked_ref()),
            _callback: callback,
        }
    }
}
impl Drop for InputControlSession {
    fn drop(&mut self) {
        self.controls.close();
    }
}

// Keep the frequent numeric frame inline; avoid one extra allocation per refresh.
#[allow(clippy::large_enum_variant)]
pub enum AudioUpdate {
    Frame {
        snapshot: LoudnessSnapshot,
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
    startup_suspension: js_sys::Promise,
    stream: Option<MediaStream>,
    input: Option<MediaStreamAudioSourceNode>,
    worklet: Option<AudioWorkletNode>,
    callback: Option<Closure<dyn FnMut(MessageEvent)>>,
    reduced_motion: bool,
}

impl AudioSession {
    pub fn new() -> Result<Self, JsValue> {
        let context = create_audio_context()?;
        if context.sample_rate() != 48_000.0 {
            retire_audio_context(&context);
            let _ = context.close();
            return Err(JsValue::from_str(
                "The loudness model requires a 48000 Hz audio context",
            ));
        }
        // Unlock and then suspend inside the initiating gesture, before native
        // fullscreen consumes Safari's activation. Await suspension before
        // assembling the graph so its first render quanta stay contiguous.
        let startup_suspension = match suspend_for_startup(&context) {
            Ok(promise) => promise,
            Err(error) => {
                retire_audio_context(&context);
                let _ = context.close();
                return Err(error);
            }
        };
        Ok(Self {
            resources: Rc::new(RefCell::new(Some(AudioResources {
                context,
                startup_suspension,
                stream: None,
                input: None,
                worklet: None,
                callback: None,
                reduced_motion: false,
            }))),
        })
    }
    pub fn is_generated(&self) -> bool {
        self.resources
            .borrow()
            .as_ref()
            .and_then(|resources| resources.stream.as_ref())
            .is_some_and(input_is_generated)
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
        let (context, startup_suspension) = {
            let guard = self.resources.borrow();
            let resources = guard.as_ref().ok_or_else(closed_session)?;
            (
                resources.context.clone(),
                resources.startup_suspension.clone(),
            )
        };
        // Build the complete graph before its sample clock starts. Connecting
        // nodes on a running context can interrupt the first render quanta.
        JsFuture::from(startup_suspension).await?;
        if self.resources.borrow().is_none() {
            return Err(closed_session());
        }
        let stream = acquire_input(&context, channel).await?;
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
            if !is_current_processor_message(&callback_node, &data) {
                let _ = callback_port.post_message(&ack);
                return;
            }
            let kind = Reflect::get(&data, &"type".into())
                .ok()
                .and_then(|v| v.as_string());
            match kind.as_deref() {
                Some("frame") => {
                    let parsed = Reflect::get(&data, &"state".into())
                        .ok()
                        .and_then(|v| v.dyn_into::<Float64Array>().ok())
                        .and_then(|v| LoudnessSnapshot::from_transport(&v.to_vec()));
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
                Some("settings-ack") => {}
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
            if !input_is_generated(&stream) {
                resources.input = Some(context.create_media_stream_source(&stream)?);
            }
            port.set_onmessage(Some(callback.as_ref().unchecked_ref()));
            if let Some(input) = &resources.input {
                input.connect_with_audio_node(&worklet)?;
            }
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
    pub fn forget_calibration(&self) {
        if let Some(node) = self
            .resources
            .borrow()
            .as_ref()
            .and_then(|r| r.worklet.as_ref())
        {
            forget_calibration(node);
        }
    }
    pub fn stop(&self) {
        self.resources.borrow_mut().take();
    }
}
fn closed_session() -> JsValue {
    JsValue::from_str("Audio session has closed")
}
fn stop_tracks(stream: &MediaStream) {
    release_input(stream);
    for track in stream.get_tracks().iter() {
        if let Ok(track) = track.dyn_into::<MediaStreamTrack>() {
            track.stop();
        }
    }
}
impl Drop for AudioResources {
    fn drop(&mut self) {
        retire_audio_context(&self.context);
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
