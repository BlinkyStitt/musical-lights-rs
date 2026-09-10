use wasm_bindgen::{JsCast, closure::Closure, prelude::wasm_bindgen};

#[wasm_bindgen(module = "/src/screen.js")]
extern "C" {
    type VisualizerScreen;

    #[wasm_bindgen(constructor)]
    fn new(element: &web_sys::HtmlElement, on_change: &js_sys::Function) -> VisualizerScreen;

    #[wasm_bindgen(method, js_name = toggleFullscreen)]
    fn toggle_fullscreen(this: &VisualizerScreen);

    #[wasm_bindgen(method)]
    fn close(this: &VisualizerScreen);
}

type ScreenChange = Closure<dyn FnMut(String, bool, bool, String)>;

/// Keep the callback alive until the browser resources have closed.
pub struct ScreenSession {
    screen: VisualizerScreen,
    _on_change: ScreenChange,
}

impl ScreenSession {
    pub fn new(
        element: &web_sys::HtmlElement,
        on_change: impl FnMut(String, bool, bool, String) + 'static,
    ) -> Self {
        let callback = Closure::new(on_change);
        let screen = VisualizerScreen::new(element, callback.as_ref().unchecked_ref());
        Self {
            screen,
            _on_change: callback,
        }
    }

    pub fn toggle_fullscreen(&self) {
        self.screen.toggle_fullscreen();
    }
}

impl Drop for ScreenSession {
    fn drop(&mut self) {
        self.screen.close();
    }
}
