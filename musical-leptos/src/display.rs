use musical_lights_core::audio::DISPLAY_BANDS;
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};

// A newly lit height remains lit for at least 350 ms. Even a pixel at the top
// cannot complete more than three automatic flash cycles in one second.
const MIN_VISIBLE_MS: f64 = 350.0;
// A critically damped release accelerates gently, then brakes as it approaches
// the live level. Reduced motion halves the release speed instead of snapping.
const RELEASE_RATE: f32 = 6.0;
const REDUCED_RELEASE_RATE: f32 = 3.0;
// The white edge marks an attack, then fades ahead of the colored trail. Both
// share the peak hold: a separate pulse clock could add flashes during a fall.
const EDGE_RELEASE_RATE: f32 = 10.0;
// Less than 0.04 pixels at the graph's maximum height. Settle the numeric tail
// here so silence reaches exact zero without an endless stream of DOM writes.
const SETTLE_DISTANCE: f32 = 0.0001;

#[derive(Clone, Copy, Default)]
struct FallingBand {
    height: f32,
    velocity: f32,
    hold_until_ms: f64,
    edge: f32,
}

#[derive(Clone, Copy, Default, PartialEq)]
pub struct DisplayFrame {
    pub levels: [f32; DISPLAY_BANDS],
    pub edges: [f32; DISPLAY_BANDS],
}

pub struct DisplayEnvelope {
    bands: [FallingBand; DISPLAY_BANDS],
    current: [f32; DISPLAY_BANDS],
    pending: [f32; DISPLAY_BANDS],
    last_frame_ms: f64,
}

impl DisplayEnvelope {
    pub fn new(now_ms: f64) -> Self {
        Self {
            bands: [FallingBand::default(); DISPLAY_BANDS],
            current: [0.0; DISPLAY_BANDS],
            pending: [0.0; DISPLAY_BANDS],
            last_frame_ms: now_ms,
        }
    }

    /// Retain even a short tap between screen frames. Audio analysis never
    /// waits for drawing, and queued messages cannot replay animation frames.
    pub fn push(&mut self, values: [f32; DISPLAY_BANDS]) {
        self.current = values;
        for (peak, value) in self.pending.iter_mut().zip(values) {
            *peak = peak.max(value);
        }
    }

    pub fn frame(&mut self, now_ms: f64, reduced_motion: bool) -> DisplayFrame {
        let previous_ms = self.last_frame_ms;
        self.last_frame_ms = now_ms;
        let levels = std::array::from_fn(|i| {
            // The last audio level remains the floor between audio callbacks.
            // Pending peaks preserve taps that arrive between screen frames.
            let input = self.current[i].max(std::mem::take(&mut self.pending[i]));
            let band = &mut self.bands[i];
            if input > band.height {
                // No attack easing: the next screen frame reaches the input.
                band.height = input;
                band.velocity = 0.0;
                band.hold_until_ms = now_ms + MIN_VISIBLE_MS;
                band.edge = 1.0;
            } else if now_ms > band.hold_until_ms {
                let elapsed_s = ((now_ms - previous_ms.max(band.hold_until_ms)) / 1000.0) as f32;
                let rate = if reduced_motion {
                    REDUCED_RELEASE_RATE
                } else {
                    RELEASE_RATE
                };
                let distance = band.height - input;
                // Bound the incoming velocity when the live floor rises. This
                // keeps the damped solution monotonic and above that floor.
                let velocity = band.velocity.min(rate * distance);
                let coefficient = rate * distance - velocity;
                let decay = (-rate * elapsed_s).exp();
                let remaining = (distance + coefficient * elapsed_s) * decay;
                band.height = input + remaining;
                band.velocity = (velocity + rate * coefficient * elapsed_s) * decay;
                if remaining <= SETTLE_DISTANCE {
                    band.height = input;
                    band.velocity = 0.0;
                }
                let edge_rate = if reduced_motion {
                    EDGE_RELEASE_RATE / 2.0
                } else {
                    EDGE_RELEASE_RATE
                };
                band.edge *= (-edge_rate * elapsed_s).exp();
                if band.edge <= SETTLE_DISTANCE || band.height == 0.0 {
                    band.edge = 0.0;
                }
            }
            band.height
        });
        DisplayFrame {
            levels,
            edges: self.bands.map(|band| band.edge),
        }
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

/// One reusable animation callback, owned by the microphone view. Its weak
/// reference avoids a callback/resource cycle; dropping the owner cancels RAF.
#[derive(Clone)]
pub struct DisplayAnimation(Rc<RefCell<Option<AnimationResources>>>);

struct AnimationResources {
    window: web_sys::Window,
    reduced_motion: Option<web_sys::MediaQueryList>,
    display: DisplayEnvelope,
    frame_rate: FrameRate,
    request: Option<i32>,
    callback: Option<Closure<dyn FnMut(f64)>>,
}

impl DisplayAnimation {
    pub fn new(
        mut on_frame: impl FnMut(DisplayFrame, Option<f64>) + 'static,
    ) -> Result<Self, JsValue> {
        let window =
            web_sys::window().ok_or_else(|| JsValue::from_str("Browser window is unavailable"))?;
        let now = window
            .performance()
            .ok_or_else(|| JsValue::from_str("Browser clock is unavailable"))?
            .now();
        let reduced_motion = window.match_media("(prefers-reduced-motion: reduce)")?;
        let resources = Rc::new(RefCell::new(Some(AnimationResources {
            window,
            reduced_motion,
            display: DisplayEnvelope::new(now),
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
            on_frame(
                resources.display.frame(now_ms, reduced_motion),
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

    pub fn push(&self, values: [f32; DISPLAY_BANDS]) {
        if let Some(resources) = self.0.borrow_mut().as_mut() {
            resources.display.push(values);
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
    use super::*;

    #[test]
    fn white_edges_mark_the_attack_and_fade_before_the_rainbow_trail() {
        for hz in [30, 60, 120, 144, 240] {
            for reduced_motion in [false, true] {
                let mut display = DisplayEnvelope::new(0.0);
                assert_eq!(
                    display.frame(0.0, reduced_motion).edges,
                    [0.0; DISPLAY_BANDS]
                );
                let mut tap = [0.0; DISPLAY_BANDS];
                tap[3] = 0.8;
                display.push(tap);
                // A tap shorter than a screen frame still gets its white edge.
                display.push([0.0; DISPLAY_BANDS]);
                let attack = display.frame(0.0, reduced_motion);
                assert_eq!(attack.levels, tap);
                let mut edges = [0.0; DISPLAY_BANDS];
                edges[3] = 1.0;
                assert_eq!(attack.edges, edges);
                assert_eq!(display.frame(350.0, reduced_motion).edges, edges);
                let mut previous = 1.0;
                let seconds = if reduced_motion { 2 } else { 1 };
                for frame in 1..=hz * seconds {
                    let now = 350.0 + f64::from(frame) * 1000.0 / f64::from(hz);
                    let frame = display.frame(now, reduced_motion);
                    assert!((0.0..=previous).contains(&frame.edges[3]));
                    assert!(frame.edges[3] <= frame.levels[3] / 0.8);
                    previous = frame.edges[3];
                }
                assert_eq!(previous, 0.0);
                // A new attack cancels the fade without waiting for CSS.
                display.push(tap);
                assert_eq!(display.frame(2500.0, reduced_motion).edges, edges);
            }
        }
    }

    #[test]
    fn steady_sound_does_not_retrigger_white_flashes_or_replay_after_a_stall() {
        let mut display = DisplayEnvelope::new(0.0);
        display.push([0.5; DISPLAY_BANDS]);
        assert_eq!(display.frame(0.0, false).edges, [1.0; DISPLAY_BANDS]);
        assert_eq!(display.frame(2000.0, false).edges, [0.0; DISPLAY_BANDS]);
        for ms in 2001..3000 {
            display.push([0.5; DISPLAY_BANDS]);
            let frame = display.frame(f64::from(ms), false);
            assert_eq!(frame.levels, [0.5; DISPLAY_BANDS]);
            assert_eq!(frame.edges, [0.0; DISPLAY_BANDS]);
        }
    }

    #[test]
    fn combined_bar_and_white_edge_limit_flashes_under_rapid_changes() {
        // Sample the fixed side edge and the moving top edge at each height.
        // Count luminance reversals >= 0.1, including a white border crossing a
        // pixel that was already colored. Height-only checks miss that case.
        for reduced_motion in [false, true] {
            for period_ms in [20, 80, 150, 250, 350, 500, 800] {
                for plot_luminance in [0.01_f32, 0.92] {
                    let mut display = DisplayEnvelope::new(0.0);
                    let mut previous = [plot_luminance; 200];
                    let mut direction = [0_i8; 200];
                    let mut reversals: [Vec<usize>; 200] = std::array::from_fn(|_| Vec::new());
                    for ms in (0..6000).step_by(2) {
                        let input = if ms % period_ms < 10 { 1.0 } else { 0.0 };
                        display.push([input; DISPLAY_BANDS]);
                        let frame = display.frame(ms as f64, reduced_motion);
                        for pixel in 0..200 {
                            let y = ((pixel % 100) as f32 + 0.5) / 100.0;
                            let height = frame.levels[0];
                            let lit = y <= height;
                            let border = pixel < 100 || height - y <= 1.0 / 320.0;
                            let luminance = if lit {
                                let color = 0.26;
                                if border {
                                    color + (1.0 - color) * frame.edges[0]
                                } else {
                                    color
                                }
                            } else {
                                plot_luminance
                            };
                            let delta = luminance - previous[pixel];
                            let next = if delta >= 0.1 {
                                1
                            } else if delta <= -0.1 {
                                -1
                            } else {
                                0
                            };
                            if next != 0 {
                                if next != direction[pixel] {
                                    reversals[pixel].push(ms);
                                    reversals[pixel].retain(|&time| ms - time < 1000);
                                    assert!(
                                        reversals[pixel].len() <= 7,
                                        "more than three flash pairs at {ms} ms, pixel {pixel}, period {period_ms}, reduced={reduced_motion}, plot={plot_luminance}"
                                    );
                                }
                                direction[pixel] = next;
                                previous[pixel] = luminance;
                            } else if direction[pixel] == 1 {
                                previous[pixel] = previous[pixel].max(luminance);
                            } else if direction[pixel] == -1 {
                                previous[pixel] = previous[pixel].min(luminance);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn tap_reaches_its_peak_on_the_next_frame() {
        let mut display = DisplayEnvelope::new(0.0);
        display.push([0.8; DISPLAY_BANDS]);
        display.push([0.0; DISPLAY_BANDS]);
        assert_eq!(display.frame(16.0, false).levels, [0.8; DISPLAY_BANDS]);
        display.push([1.0; DISPLAY_BANDS]);
        assert_eq!(display.frame(32.0, false).levels, [1.0; DISPLAY_BANDS]);
    }

    #[test]
    fn fall_brakes_at_the_live_level_and_is_independent_of_frame_rate() {
        for hz in [30, 60, 120, 144, 240] {
            let mut display = DisplayEnvelope::new(0.0);
            display.push([1.0; DISPLAY_BANDS]);
            display.frame(0.0, false);
            display.push([0.0; DISPLAY_BANDS]);
            let mut previous = 1.0;
            for frame in 1..=hz * 2 {
                let now = 350.0 + f64::from(frame) * 1000.0 / f64::from(hz);
                let level = display.frame(now, false).levels[0];
                assert!(level <= previous);
                assert!(level >= 0.0);
                if hz == 120 {
                    assert!((previous - level) * 320.0 < 6.0, "large fall at 120 Hz");
                }
                previous = level;
                if frame == hz {
                    // Exact critically damped response after one second.
                    assert!((level - 7.0 * (-6.0_f32).exp()).abs() < 1e-5);
                    assert!(display.bands[0].velocity < 0.1);
                }
            }
            assert_eq!(display.bands[0].height, 0.0);
            assert_eq!(display.bands[0].velocity, 0.0);
        }
    }

    #[test]
    fn a_new_peak_cancels_downward_velocity_immediately() {
        let mut display = DisplayEnvelope::new(0.0);
        display.push([1.0; DISPLAY_BANDS]);
        display.frame(0.0, false);
        display.push([0.0; DISPLAY_BANDS]);
        display.frame(700.0, false);
        assert!(display.bands[0].velocity > 0.0);
        display.push([0.9; DISPLAY_BANDS]);
        assert_eq!(display.frame(716.0, false).levels, [0.9; DISPLAY_BANDS]);
        assert_eq!(display.bands[0].velocity, 0.0);
    }

    #[test]
    fn a_rising_floor_brakes_the_fall_before_contact() {
        for reduced_motion in [false, true] {
            let mut display = DisplayEnvelope::new(0.0);
            display.push([1.0; DISPLAY_BANDS]);
            display.frame(0.0, reduced_motion);
            display.push([0.0; DISPLAY_BANDS]);
            let height = display.frame(800.0, reduced_motion).levels[0];
            let floor = height - 0.001;
            display.push([floor; DISPLAY_BANDS]);
            let next = display.frame(808.0, reduced_motion).levels[0];
            assert!(
                next > floor + 0.0008,
                "the bar hit the rising floor abruptly"
            );
            assert!(next < height);
            let mut previous = next;
            for ms in (816..=2400).step_by(8) {
                let level = display.frame(ms as f64, reduced_motion).levels[0];
                assert!((floor..=previous).contains(&level));
                previous = level;
            }
            assert_eq!(previous, floor);
        }
    }

    #[test]
    fn repeated_taps_limit_flashes_at_every_meter_height() {
        for reduced_motion in [false, true] {
            for period_ms in [20, 80, 150, 250, 350, 500, 800] {
                let mut display = DisplayEnvelope::new(0.0);
                let mut was_lit = [false; 100];
                let mut rises: [Vec<usize>; 100] = std::array::from_fn(|_| Vec::new());
                for ms in (0..6000).step_by(5) {
                    let input = if ms % period_ms == 0 { 1.0 } else { 0.0 };
                    display.push([input; DISPLAY_BANDS]);
                    let level = display.frame(ms as f64, reduced_motion).levels[0];
                    assert!((0.0..=1.0).contains(&level));
                    for (pixel, was_lit) in was_lit.iter_mut().enumerate() {
                        let lit = level >= (pixel + 1) as f32 / 100.0;
                        if lit && !*was_lit {
                            rises[pixel].push(ms);
                            assert!(
                                rises[pixel]
                                    .iter()
                                    .filter(|&&rise| ms - rise < 1000)
                                    .count()
                                    <= 3
                            );
                        }
                        *was_lit = lit;
                    }
                }
            }
        }
    }

    #[test]
    fn reduced_motion_uses_a_gentler_fall_without_a_single_frame_drop() {
        let mut normal = DisplayEnvelope::new(0.0);
        let mut reduced = DisplayEnvelope::new(0.0);
        for display in [&mut normal, &mut reduced] {
            display.push([1.0; DISPLAY_BANDS]);
            display.frame(0.0, false);
            display.push([0.0; DISPLAY_BANDS]);
        }
        assert_eq!(reduced.frame(350.0, true).levels, [1.0; DISPLAY_BANDS]);
        let mut previous = 1.0;
        for ms in (360..=2000).step_by(10) {
            let level = reduced.frame(ms as f64, true).levels[0];
            assert!(level <= previous);
            assert!(level >= normal.frame(ms as f64, false).levels[0]);
            assert!((previous - level) * 320.0 < 4.0);
            previous = level;
        }
        assert_eq!(reduced.frame(5000.0, true).levels, [0.0; DISPLAY_BANDS]);
    }

    #[test]
    fn frame_rate_counts_real_intervals_and_includes_stalls() {
        for hz in [30, 60, 120, 144, 240] {
            let mut counter = FrameRate::default();
            assert_eq!(counter.tick(0.0), None);
            for frame in 1..hz {
                assert_eq!(
                    counter.tick(f64::from(frame) * 1000.0 / f64::from(hz)),
                    None
                );
            }
            assert_eq!(counter.tick(1000.0), Some(f64::from(hz)));
            // A full second with no callback counts as one delayed interval.
            assert_eq!(counter.tick(2000.0), Some(1.0));
            for frame in 1..hz {
                assert_eq!(
                    counter.tick(2000.0 + f64::from(frame) * 1000.0 / f64::from(hz)),
                    None
                );
            }
            assert_eq!(counter.tick(3000.0), Some(f64::from(hz)));
        }
    }

    #[test]
    fn fall_stops_at_each_live_band_level_even_between_audio_callbacks() {
        for reduced_motion in [false, true] {
            let mut display = DisplayEnvelope::new(0.0);
            display.push([1.0; DISPLAY_BANDS]);
            display.frame(0.0, reduced_motion);
            let floors = std::array::from_fn(|i| (i + 1) as f32 / 25.0);
            display.push(floors);
            for ms in (10..=5000).step_by(10) {
                let heights = display.frame(ms as f64, reduced_motion).levels;
                for (height, floor) in heights.into_iter().zip(floors) {
                    assert!(height >= floor, "{height} fell below {floor} at {ms} ms");
                }
            }
            assert_eq!(display.frame(5010.0, reduced_motion).levels, floors);
            // A new lower level starts a fresh fall; no old downward velocity
            // can carry a bar below the new floor.
            display.push([0.02; DISPLAY_BANDS]);
            assert!(
                display
                    .frame(5020.0, reduced_motion)
                    .levels
                    .iter()
                    .all(|&v| v >= 0.02)
            );
            assert_eq!(
                display.frame(10000.0, reduced_motion).levels,
                [0.02; DISPLAY_BANDS]
            );
            display.push([0.7; DISPLAY_BANDS]);
            assert_eq!(
                display.frame(10016.0, reduced_motion).levels,
                [0.7; DISPLAY_BANDS]
            );
            assert_eq!(
                display.frame(15000.0, reduced_motion).levels,
                [0.7; DISPLAY_BANDS]
            );
        }
    }
}
