mod audio;
mod counter;

use leptos::*;

pub use audio::Microphone;
pub use counter::SimpleCounter;

/// The main app.
#[component]
pub fn App() -> impl IntoView {
    view! {
        <h1>Musical Lights</h1>

        <SimpleCounter initial_value=0 step=1/>

        <Microphone/>
    }
}
