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
                <section class="intro" aria-labelledby="page-title">
                    <p class="eyebrow">"A LITTLE SOUND. A LITTLE COLOR."</p>
                    <h1 id="page-title">"Musical Lights"</h1>
                    <p class="lede">"Give your music room to move."</p>
                    <p>"Turn on your microphone and watch the spectrum settle into sound."</p>
                </section>
                <DancingLights/>
                <section class="how-it-works" aria-label="About the display">
                    <div><h3>"Every band has room"</h3><p>"All 24 bands stay separate, from the five bass bands to the brightest details."</p></div>
                    <div><h3>"An easier pace"</h3><p>"Slow, smooth updates keep sharp taps from becoming rapid flashes. Pause whenever you like."</p></div>
                    <div><h3>"Your sound stays here"</h3><p>"Audio is processed in this browser. This page does not record or upload it."</p></div>
                </section>
            </div>
        </ErrorBoundary>
    }
}
