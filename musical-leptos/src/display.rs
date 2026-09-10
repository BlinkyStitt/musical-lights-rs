use crate::wasm_audio::AudioSession;
pub use musical_lights_core::audio::visual::DisplayFrame;
use musical_lights_core::audio::visual::{DISPLAY_BANDS, DisplaySnapshot};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};

/// Count actual animation intervals, including delayed frames, over at least
/// one second. Audio callbacks and unchanged bar heights do not affect the rate.
#[derive(Default)]
struct FrameRate {
    started_ms: Option<f64>,
    intervals: u32,
}

impl FrameRate {
    fn tick(&mut self, now_ms: f64) -> Option<f64> {
        let started = *self.started_ms.get_or_insert(now_ms);
        if now_ms <= started {
            return None;
        }
        self.intervals += 1;
        let elapsed = now_ms - started;
        if elapsed < 1000.0 {
            return None;
        }
        let fps = f64::from(self.intervals) * 1000.0 / elapsed;
        self.started_ms = Some(now_ms);
        self.intervals = 0;
        Some(fps)
    }
}

/// One reusable animation callback, owned by the microphone view. Its weak
/// reference avoids a callback/resource cycle; dropping the owner cancels RAF.
#[derive(Clone)]
pub struct DisplayAnimation(Rc<RefCell<Option<AnimationResources>>>);

struct AnimationResources {
    window: web_sys::Window,
    reduced_motion: Option<web_sys::MediaQueryList>,
    display: DisplaySnapshot<DISPLAY_BANDS>,
    session: AudioSession,
    motion: bool,
    frame_rate: FrameRate,
    request: Option<i32>,
    callback: Option<Closure<dyn FnMut(f64)>>,
}

impl DisplayAnimation {
    pub fn new(
        session: AudioSession,
        mut on_frame: impl FnMut(DisplayFrame<DISPLAY_BANDS>, Option<f64>) + 'static,
    ) -> Result<Self, JsValue> {
        let window =
            web_sys::window().ok_or_else(|| JsValue::from_str("Browser window is unavailable"))?;
        let reduced_motion = window.match_media("(prefers-reduced-motion: reduce)")?;
        let motion = reduced_motion.as_ref().is_some_and(|query| query.matches());
        session.set_reduced_motion(motion);
        let resources = Rc::new(RefCell::new(Some(AnimationResources {
            window,
            reduced_motion,
            display: DisplaySnapshot::new(session.time()),
            session,
            motion,
            frame_rate: FrameRate::default(),
            request: None,
            callback: None,
        })));
        let weak = Rc::downgrade(&resources);
        let callback = Closure::new(move |now_ms: f64| {
            let Some(resources) = weak.upgrade() else {
                return;
            };
            let mut guard = resources.borrow_mut();
            let Some(resources) = guard.as_mut() else {
                return;
            };
            resources.request = None;
            let reduced_motion = resources
                .reduced_motion
                .as_ref()
                .is_some_and(|query| query.matches());
            if resources.motion != reduced_motion {
                resources.session.set_reduced_motion(reduced_motion);
                resources.motion = reduced_motion;
            }
            on_frame(
                resources.display.frame(resources.session.time()),
                resources.frame_rate.tick(now_ms),
            );
            resources.request = resources
                .window
                .request_animation_frame(
                    resources
                        .callback
                        .as_ref()
                        .unwrap()
                        .as_ref()
                        .unchecked_ref(),
                )
                .ok();
        });
        {
            let mut guard = resources.borrow_mut();
            let resources = guard.as_mut().unwrap();
            resources.request = Some(
                resources
                    .window
                    .request_animation_frame(callback.as_ref().unchecked_ref())?,
            );
            resources.callback = Some(callback);
        }
        Ok(Self(resources))
    }

    /// Cancel drawing now, even if asynchronous audio setup owns another handle.
    pub fn stop(&self) {
        self.0.borrow_mut().take();
    }

    pub fn push(&self, snapshot: DisplaySnapshot<DISPLAY_BANDS>) {
        if let Some(resources) = self.0.borrow_mut().as_mut()
            && snapshot.timestamp() >= resources.display.timestamp()
        {
            resources.display = snapshot;
        }
    }
}

impl Drop for AnimationResources {
    fn drop(&mut self) {
        if let Some(request) = self.request {
            let _ = self.window.cancel_animation_frame(request);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::FrameRate;
    #[test]
    fn frame_rate_counts_actual_intervals_including_stalls() {
        let mut rate = FrameRate::default();
        assert_eq!(rate.tick(0.0), None);
        for i in 1..60 {
            assert_eq!(rate.tick(i as f64 * 1000.0 / 60.0), None);
        }
        assert_eq!(rate.tick(1000.0), Some(60.0));
        assert_eq!(rate.tick(2000.0), Some(1.0));
    }
}
