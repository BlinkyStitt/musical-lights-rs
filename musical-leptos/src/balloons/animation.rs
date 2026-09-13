use super::{BALLOON_COUNT, BalloonWorld, Bar, Geometry, Vector};
use musical_lights_core::audio::visual::{DISPLAY_BANDS, DisplayFrame};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{JsCast, JsValue, closure::Closure, prelude::wasm_bindgen};
use web_sys::{HtmlElement, MediaQueryList, Window};

#[wasm_bindgen(module = "/src/balloons/input.js")]
extern "C" {
    type BalloonInput;
    #[wasm_bindgen(constructor)]
    fn new(
        layer: &HtmlElement,
        pointer: &js_sys::Function,
        tilt: &js_sys::Function,
        shake: &js_sys::Function,
    ) -> BalloonInput;
    #[wasm_bindgen(method)]
    fn close(this: &BalloonInput);
    #[wasm_bindgen(method, js_name = startMotion)]
    fn start_motion(this: &BalloonInput);
    #[wasm_bindgen(method, js_name = stopMotion)]
    fn stop_motion(this: &BalloonInput);
}

type SensorCallback = Closure<dyn FnMut(f64, f64, f64)>;

struct InputResources {
    input: BalloonInput,
    _pointer: Closure<dyn FnMut(f64, f64, bool)>,
    _tilt: SensorCallback,
    _shake: SensorCallback,
}

impl Drop for InputResources {
    fn drop(&mut self) {
        self.input.close();
    }
}

/// The mounted graph owns one RAF and mouse input. Microphone sessions own
/// only optional sensor input and bar updates; gravity also runs with audio off.
pub struct BalloonAnimation(Rc<RefCell<Resources>>);

struct Resources {
    window: Window,
    layer: HtmlElement,
    nodes: Vec<HtmlElement>,
    meters: Vec<HtmlElement>,
    track: HtmlElement,
    world: BalloonWorld,
    frame: DisplayFrame<DISPLAY_BANDS>,
    geometry: Geometry,
    size: (f64, f64),
    reduced_motion: Option<MediaQueryList>,
    input: Option<InputResources>,
    request: Option<i32>,
    callback: Option<Closure<dyn FnMut(f64)>>,
    last_ms: Option<f64>,
}

impl BalloonAnimation {
    pub fn new(layer: &HtmlElement, world: BalloonWorld) -> Result<Self, JsValue> {
        let window = web_sys::window().ok_or_else(|| JsValue::from_str("No browser window"))?;
        let elements = |parent: &web_sys::Element, selector| -> Result<Vec<HtmlElement>, JsValue> {
            let nodes = parent.query_selector_all(selector)?;
            (0..nodes.length())
                .map(|i| nodes.item(i).unwrap().dyn_into().map_err(Into::into))
                .collect()
        };
        let nodes = elements(layer, ".balloon")?;
        let graph = layer
            .parent_element()
            .ok_or_else(|| JsValue::from_str("No spectrum graph"))?;
        let meters = elements(&graph, ".bark-group")?;
        if nodes.len() != BALLOON_COUNT || meters.len() != DISPLAY_BANDS {
            return Err(JsValue::from_str("Incomplete balloon or meter layer"));
        }
        let track = meters[0]
            .query_selector(".meter-track")?
            .ok_or_else(|| JsValue::from_str("No meter drawing area"))?
            .dyn_into()?;
        let reduced_motion = window.match_media("(prefers-reduced-motion: reduce)")?;
        let resources = Rc::new(RefCell::new(Resources {
            window,
            layer: layer.clone(),
            nodes,
            meters,
            track,
            world,
            frame: DisplayFrame::default(),
            geometry: Geometry {
                bars: [Bar {
                    left: 0.0,
                    right: 0.0,
                }; DISPLAY_BANDS],
                bar_height: 0.0,
                aspect: 1.0,
                baseline: 0.0,
            },
            size: (0.0, 0.0),
            reduced_motion,
            input: None,
            request: None,
            callback: None,
            last_ms: None,
        }));
        let weak = Rc::downgrade(&resources);
        let callback = Closure::new(move |now_ms: f64| {
            let Some(resources) = weak.upgrade() else {
                return;
            };
            let mut resources = resources.borrow_mut();
            resources.request = None;
            let dt = resources
                .last_ms
                .replace(now_ms)
                .map_or(0.0, |last| (now_ms - last) / 1000.0);
            resources.measure();
            resources.world.reduced = resources
                .reduced_motion
                .as_ref()
                .is_some_and(|query| query.matches());
            let frame = resources.frame;
            let geometry = resources.geometry;
            resources.world.step(dt, frame, geometry);
            resources.render();
            if resources.schedule().is_err() {
                resources.stop();
            }
        });
        resources.borrow_mut().callback = Some(callback);
        let animation = Self(resources);
        animation.connect_input();
        animation.0.borrow_mut().schedule()?;
        Ok(animation)
    }

    fn connect_input(&self) {
        let weak = Rc::downgrade(&self.0);
        let pointer = Closure::new(move |x: f64, y: f64, inside: bool| {
            if let Some(resources) = weak.upgrade() {
                resources.borrow_mut().world.pointer = inside.then_some(Vector { x, y });
            }
        });
        let weak = Rc::downgrade(&self.0);
        let tilt = Closure::new(move |beta, gamma, angle| {
            if let Some(resources) = weak.upgrade() {
                resources.borrow_mut().world.tilt(beta, gamma, angle);
            }
        });
        let weak = Rc::downgrade(&self.0);
        let shake = Closure::new(move |x, y, angle| {
            if let Some(resources) = weak.upgrade() {
                resources.borrow_mut().world.shake(x, y, angle);
            }
        });
        let mut resources = self.0.borrow_mut();
        resources.world.reduced = resources
            .reduced_motion
            .as_ref()
            .is_some_and(|query| query.matches());
        resources.input = Some(InputResources {
            input: BalloonInput::new(
                &resources.layer,
                pointer.as_ref().unchecked_ref(),
                tilt.as_ref().unchecked_ref(),
                shake.as_ref().unchecked_ref(),
            ),
            _pointer: pointer,
            _tilt: tilt,
            _shake: shake,
        });
    }

    /// Call directly from the user's click, before any asynchronous audio work.
    pub fn start_listening(&self) {
        if let Some(input) = &self.0.borrow().input {
            input.input.start_motion();
        }
    }

    pub fn push(&self, frame: DisplayFrame<DISPLAY_BANDS>) {
        self.0.borrow_mut().frame = frame;
    }
    pub fn stop_listening(&self) {
        let mut resources = self.0.borrow_mut();
        if let Some(input) = &resources.input {
            input.input.stop_motion();
        }
        resources.frame = DisplayFrame::default();
        resources.world.clear_motion();
    }
}

impl Resources {
    fn schedule(&mut self) -> Result<(), JsValue> {
        self.request =
            Some(self.window.request_animation_frame(
                self.callback.as_ref().unwrap().as_ref().unchecked_ref(),
            )?);
        Ok(())
    }

    fn measure(&mut self) {
        let bounds = self.layer.get_bounding_client_rect();
        let size = (bounds.width(), bounds.height());
        if size == self.size || size.0 <= 0.0 || size.1 <= 0.0 {
            return;
        }
        self.size = size;
        let bars = std::array::from_fn(|i| {
            let bar = self.meters[i].get_bounding_client_rect();
            Bar {
                left: (bar.left() - bounds.left()) / size.0,
                right: (bar.right() - bounds.left()) / size.0,
            }
        });
        // The fixed track excludes the headroom and the colored baseline.
        let bar_height = self.track.get_bounding_client_rect().height() / size.1;
        if self.geometry.bar_height > 0.0 {
            for level in &mut self.world.previous_levels {
                *level *= bar_height / self.geometry.bar_height;
            }
        }
        self.geometry = Geometry {
            bars,
            bar_height,
            aspect: size.0 / size.1,
            baseline: (self.meters[0].get_bounding_client_rect().bottom() - bounds.bottom())
                / size.1,
        };
    }

    fn render(&self) {
        for (node, balloon) in self.nodes.iter().zip(&self.world.balloons) {
            let style = node.style();
            let _ = style.set_property("left", &format!("{}%", balloon.position.x * 100.0));
            let _ = style.set_property("top", &format!("{}%", (1.0 - balloon.position.y) * 100.0));
            let _ = style.set_property("--balloon-color", &balloon.css_color());
        }
    }

    fn stop(&mut self) {
        if let Some(request) = self.request.take() {
            let _ = self.window.cancel_animation_frame(request);
        }
        self.input.take();
        self.last_ms = None;
        self.frame = DisplayFrame::default();
    }
}

impl Drop for Resources {
    fn drop(&mut self) {
        self.stop();
    }
}
