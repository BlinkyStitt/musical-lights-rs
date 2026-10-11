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
                <h2>"Understanding continuous filters"</h2>
                <p>"The ISO 532-1 filter model updates every 2 milliseconds. All 28 internal third-octave filters contribute to a specific-loudness pattern across 24 Bark. Each displayed band integrates one Bark. Bark is the model's hearing-frequency scale."</p>
                <p>"The filters keep their state across audio blocks. Low-frequency filters need more time to respond than high-frequency filters. The 2 millisecond output grid and 1 millisecond lookahead do not specify total microphone-to-screen delay. Visual smoothing and physical bar travel add separate response times."</p>
                <a href="https://mosqito.readthedocs.io/en/latest/source/reference/mosqito.sq_metrics.loudness.loudness_zwtv.loudness_zwtv.html">"Read the time-varying loudness method"</a>
            </section>
        </div>
    }
}
