use wasm_bindgen::{JsCast, closure::Closure, prelude::wasm_bindgen};

#[wasm_bindgen(module = "/src/screen.js")]
extern "C" {
    type VisualizerScreen;

    #[wasm_bindgen(constructor)]
    fn new(
        element: &web_sys::HtmlElement,
        on_change: &js_sys::Function,
        on_band: &js_sys::Function,
    ) -> VisualizerScreen;

    #[wasm_bindgen(method, js_name = toggleFullscreen)]
    fn toggle_fullscreen(this: &VisualizerScreen);

    #[wasm_bindgen(method)]
    fn close(this: &VisualizerScreen);
}

type ScreenChange = Closure<dyn FnMut(String, bool, String)>;

#[wasm_bindgen(module = "/src/recognition.js")]
extern "C" {
    type SongRecognition;
    #[wasm_bindgen(constructor)]
    fn new(element: &web_sys::HtmlElement) -> SongRecognition;
    #[wasm_bindgen(method)]
    fn close(this: &SongRecognition);
}

#[wasm_bindgen(module = "/src/presentation.js")]
extern "C" {
    type Presentation;
    #[wasm_bindgen(constructor)]
    fn new(element: &web_sys::HtmlElement) -> Presentation;
    #[wasm_bindgen(method)]
    fn close(this: &Presentation);
}

/// Keep the callback alive until the browser resources have closed.
pub struct ScreenSession {
    screen: VisualizerScreen,
    songs: SongRecognition,
    presentation: Presentation,
    _on_change: ScreenChange,
    _on_band: Closure<dyn FnMut(Option<u32>)>,
}

impl ScreenSession {
    pub fn new(
        element: &web_sys::HtmlElement,
        on_change: impl FnMut(String, bool, String) + 'static,
        on_band: impl FnMut(Option<u32>) + 'static,
    ) -> Self {
        let callback = Closure::new(on_change);
        let on_band = Closure::new(on_band);
        let screen = VisualizerScreen::new(
            element,
            callback.as_ref().unchecked_ref(),
            on_band.as_ref().unchecked_ref(),
        );
        Self {
            screen,
            songs: SongRecognition::new(element),
            presentation: Presentation::new(element),
            _on_change: callback,
            _on_band: on_band,
        }
    }

    pub fn toggle_fullscreen(&self) {
        self.screen.toggle_fullscreen();
    }
}

impl Drop for ScreenSession {
    fn drop(&mut self) {
        self.presentation.close();
        self.songs.close();
        self.screen.close();
    }
}
