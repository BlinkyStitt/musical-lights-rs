use crate::components::dancing_lights::{DancingLights, VisualizationMode};
use leptos::prelude::*;

#[component]
pub fn Advanced() -> impl IntoView {
    view! {
        <div class="advanced-page">
            <h1>"Advanced"</h1>
            <p>"Review audio, adjust the display, and inspect diagnostics."</p>
            <DancingLights mode=VisualizationMode::Advanced/>
            <section class="analysis-explanation" aria-label="Analysis timing">
                <h2>"Understanding the fixed window"</h2>
                <p>{format!("The analyzer examines the latest {:.1} milliseconds of audio and updates every {:.0} milliseconds. Fixed window describes the amount of audio examined, not the update rate.", musical_lights_core::audio::partial::WINDOW as f64 / 48.0, musical_lights_core::audio::partial::HOP as f64 / 48.0)}</p>
                <p>"Longer windows distinguish nearby frequencies better but spread short events over time. The Cambridge model uses longer windows for low frequencies and shorter ones for high frequencies."</p>
                <p>"Our adapted reference is not full Cambridge-model conformance. A 3.4 kHz tone differs by 33% in one frequency-slice comparison, but assigning the complete tone to one known source changes the result substantially. This does not establish a 33% error in total loudness or human perception. Display filtering and the approximately 1.13-second full-height gravity release are separate from audio analysis timing."</p>
                <a href="https://journals.sagepub.com/doi/10.1177/2331216514550620">"Read the model author’s explanation"</a>
            </section>
        </div>
    }
}
