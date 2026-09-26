use crate::wasm_audio::AudioSession;
use musical_lights_core::audio::browser::BrowserSnapshot;
use musical_lights_core::audio::visual::{DISPLAY_BANDS, DisplayFrame};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::JsValue;

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

/// Audio envelope sampled by the canvas render loop. This owns no animation clock.
#[derive(Clone)]
pub struct DisplayAnimation(Rc<RefCell<Option<AnimationResources>>>);
struct AnimationResources {
    reduced_motion: Option<web_sys::MediaQueryList>,
    display: BrowserSnapshot,
    session: AudioSession,
    motion: bool,
    frame_rate: FrameRate,
    on_frame: Box<dyn FnMut(DisplayFrame<DISPLAY_BANDS>, Option<f64>)>,
}
impl DisplayAnimation {
    pub fn new(
        session: AudioSession,
        on_frame: impl FnMut(DisplayFrame<DISPLAY_BANDS>, Option<f64>) + 'static,
    ) -> Result<Self, JsValue> {
        let window =
            web_sys::window().ok_or_else(|| JsValue::from_str("Browser window is unavailable"))?;
        let reduced_motion = window.match_media("(prefers-reduced-motion: reduce)")?;
        let motion = reduced_motion.as_ref().is_some_and(|query| query.matches());
        session.set_reduced_motion(motion);
        Ok(Self(Rc::new(RefCell::new(Some(AnimationResources {
            reduced_motion,
            display: BrowserSnapshot::new(session.time()),
            session,
            motion,
            frame_rate: FrameRate::default(),
            on_frame: Box::new(on_frame),
        })))))
    }
    pub fn tick(&self, now_ms: f64) {
        if let Some(r) = self.0.borrow_mut().as_mut() {
            let motion = r
                .reduced_motion
                .as_ref()
                .is_some_and(|query| query.matches());
            if r.motion != motion {
                r.session.set_reduced_motion(motion);
                r.motion = motion;
            }
            (r.on_frame)(r.display.frame(r.session.time()), r.frame_rate.tick(now_ms));
        }
    }
    pub fn reset_clock(&self) {
        if let Some(r) = self.0.borrow_mut().as_mut() {
            r.frame_rate = FrameRate::default();
        }
    }
    pub fn stop(&self) {
        self.0.borrow_mut().take();
    }
    pub fn push(&self, snapshot: BrowserSnapshot) {
        if let Some(r) = self.0.borrow_mut().as_mut()
            && snapshot.timestamp() >= r.display.timestamp()
        {
            r.display = snapshot;
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
