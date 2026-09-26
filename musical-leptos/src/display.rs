use crate::wasm_audio::AudioSession;
use musical_lights_core::audio::browser::BrowserSnapshot;
use musical_lights_core::audio::visual::{DISPLAY_BANDS, DisplayFrame};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::JsValue;

// Match the hat's whole-column cadence in sparkle-idf/src/main.rs:
// 55.5 FPS / 4 / 20 LEDs per column. Do not mix adjacent loudness values.
const SCROLL_COLUMN_MS: f64 = 1000.0 * 4.0 * 20.0 / 55.5;

#[derive(Default)]
struct ScrollMotion {
    last_ms: Option<f64>,
    elapsed_ms: f64,
}
impl ScrollMotion {
    fn frame(
        &mut self,
        now_ms: f64,
        enabled: bool,
        frame: DisplayFrame<DISPLAY_BANDS>,
    ) -> (DisplayFrame<DISPLAY_BANDS>, usize) {
        let elapsed = self.last_ms.map_or(0.0, |last| (now_ms - last).max(0.0));
        self.last_ms = Some(now_ms);
        self.elapsed_ms = if enabled {
            self.elapsed_ms + elapsed
        } else {
            0.0
        };
        let offset = (self.elapsed_ms / SCROLL_COLUMN_MS).floor() as usize % DISPLAY_BANDS;
        let source = |slot: usize| (slot + DISPLAY_BANDS - offset) % DISPLAY_BANDS;
        (
            DisplayFrame {
                levels: std::array::from_fn(|slot| frame.levels[source(slot)]),
                edges: std::array::from_fn(|slot| frame.edges[source(slot)]),
            },
            offset,
        )
    }
}

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
    scroll: ScrollMotion,
    scrolling_enabled: Box<dyn Fn() -> bool>,
    on_frame: Box<dyn FnMut(DisplayFrame<DISPLAY_BANDS>, Option<f64>, usize)>,
}
impl DisplayAnimation {
    pub fn new(
        session: AudioSession,
        scrolling_enabled: impl Fn() -> bool + 'static,
        on_frame: impl FnMut(DisplayFrame<DISPLAY_BANDS>, Option<f64>, usize) + 'static,
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
            scroll: ScrollMotion::default(),
            scrolling_enabled: Box::new(scrolling_enabled),
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
            let frame = r.display.frame(r.session.time());
            let enabled = (r.scrolling_enabled)() && !motion;
            let (frame, offset) = r.scroll.frame(now_ms, enabled, frame);
            (r.on_frame)(frame, r.frame_rate.tick(now_ms), offset);
        }
    }
    pub fn reset_clock(&self) {
        if let Some(r) = self.0.borrow_mut().as_mut() {
            r.frame_rate = FrameRate::default();
            r.scroll.last_ms = None;
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
    use super::{DISPLAY_BANDS, DisplayFrame, FrameRate, SCROLL_COLUMN_MS, ScrollMotion};
    #[test]
    fn hat_scroll_moves_whole_bands_right_and_wraps_at_every_frame_rate() {
        let frame = DisplayFrame {
            levels: std::array::from_fn(|i| i as f32 / 24.0),
            edges: std::array::from_fn(|i| (24 - i) as f32 / 24.0),
        };
        for fps in [30, 60, 120] {
            let mut motion = ScrollMotion::default();
            assert_eq!(motion.frame(0.0, true, frame), (frame, 0));
            for step in 1..=fps * 36 {
                let now = step as f64 * 1000.0 / fps as f64;
                let (mapped, offset) = motion.frame(now, true, frame);
                let expected = (now / SCROLL_COLUMN_MS).floor() as usize % DISPLAY_BANDS;
                assert_eq!(offset, expected);
                for source in 0..DISPLAY_BANDS {
                    let slot = (source + expected) % DISPLAY_BANDS;
                    assert_eq!(mapped.levels[slot], frame.levels[source]);
                    assert_eq!(mapped.edges[slot], frame.edges[source]);
                }
            }
        }
    }
    #[test]
    fn scroll_pauses_without_catchup_and_disabled_motion_restores_source_order() {
        let frame = DisplayFrame::default();
        let mut motion = ScrollMotion::default();
        motion.frame(0.0, true, frame);
        assert_eq!(motion.frame(SCROLL_COLUMN_MS + 1.0, true, frame).1, 1);
        motion.last_ms = None; // hidden page / lost graphics context
        assert_eq!(motion.frame(60000.0, true, frame).1, 1);
        assert_eq!(motion.frame(60001.0, false, frame), (frame, 0));
        assert_eq!(motion.frame(60002.0, true, frame).1, 0);
    }
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
