use musical_lights_core::{
    audio::visual::{DISPLAY_BANDS, DisplayFrame},
    lights::Gradient,
};
use wasm_bindgen::{JsCast, prelude::*};

#[wasm_bindgen(module = "/src/physics.js")]
extern "C" {
    type Scene;
    #[wasm_bindgen(constructor)]
    fn new(
        layer: &web_sys::HtmlElement,
        palette: &[f32],
        on_frame: &js_sys::Function,
        wave_light: &js_sys::Function,
    ) -> Scene;
    #[wasm_bindgen(method)]
    fn push(this: &Scene, levels: &[f32], edges: &[f32], scrolling: bool);
    #[wasm_bindgen(method, js_name = clearAudio)]
    fn clear_audio(this: &Scene);
    #[wasm_bindgen(method)]
    fn close(this: &Scene);
}

pub struct PhysicsAnimation {
    scene: Scene,
    _frame: Closure<dyn FnMut(f64, bool)>,
    _wave_light: Closure<dyn FnMut(u32, f32, f32, f64, bool) -> f32>,
}
impl PhysicsAnimation {
    pub fn new(
        layer: &web_sys::HtmlElement,
        palette: Gradient<DISPLAY_BANDS>,
        on_frame: impl FnMut(f64, bool) + 'static,
    ) -> Self {
        let colors: Vec<_> = palette
            .colors
            .iter()
            .flat_map(|c| [c.red, c.green, c.blue])
            .collect();
        let frame = Closure::new(on_frame);
        let mut lights =
            [musical_lights_core::lights::musical_motion::WaveLight::default(); DISPLAY_BANDS];
        let wave_light = Closure::new(
            move |band: u32, height: f32, maximum: f32, seconds: f64, enabled: bool| {
                lights
                    .get_mut(band as usize)
                    .map_or(0.0, |light| light.sample(height, maximum, seconds, enabled))
            },
        );
        Self {
            scene: Scene::new(
                layer,
                &colors,
                frame.as_ref().unchecked_ref(),
                wave_light.as_ref().unchecked_ref(),
            ),
            _frame: frame,
            _wave_light: wave_light,
        }
    }
    pub fn clear_audio(&self) {
        self.scene.clear_audio();
    }
    pub fn push(&self, frame: DisplayFrame<DISPLAY_BANDS>, scrolling: bool) {
        self.scene.push(&frame.levels, &frame.edges, scrolling);
    }
}
impl Drop for PhysicsAnimation {
    fn drop(&mut self) {
        self.scene.close();
    }
}
