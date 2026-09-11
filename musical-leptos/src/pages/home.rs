use crate::components::DancingLights;
use leptos::prelude::*;

/// Default Home Page
#[component]
pub fn Home() -> impl IntoView {
    view! {
        <ErrorBoundary fallback=|errors| {
            view! {
                <h1>"Uh oh! Something went wrong!"</h1>

                <p>"Errors: "</p>
                // Render a list of errors as strings - good for development purposes
                <ul>
                    {move || {
                        errors
                            .get()
                            .into_iter()
                            .map(|(_, e)| view! { <li>{e.to_string()}</li> })
                            .collect_view()
                    }}

                </ul>
            }
        }>
            <div class="home">
                <DancingLights/>
                <section class="intro" aria-labelledby="page-title">
                    <p class="eyebrow">"ABOUT THE DISPLAY"</p>
                    <h1 id="page-title">"Musical Lights"</h1>
                    <p>"24 frequency bands, from bass to treble."</p>
                </section>
                <section class="how-it-works" aria-label="About the display">
                    <div><h3>"An easier pace"</h3><p>"Meters rise with each beat, then fall gently. Tap or hover over a band to see its frequency edges."</p></div>
                    <div><h3>"Your sound stays here"</h3><p>"Audio is processed in this browser. This page does not record or upload it."</p></div>
                </section>
            </div>
        </ErrorBoundary>
    }
}
