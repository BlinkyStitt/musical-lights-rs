use leptos::prelude::*;
use leptos_meta::*;
use leptos_router::{components::*, path};

mod components;
mod display;
mod pages;
mod wasm_audio;

// Top-Level pages
use crate::pages::about::About;
use crate::pages::home::Home;
use crate::pages::not_found::NotFound;

/// An app router which renders the homepage and handles 404's
///
/// TODO: how do make the base on the router dynamic to work with github pages?
#[component]
pub fn App() -> impl IntoView {
    // Provides context that manages stylesheets, titles, meta tags, etc.
    provide_meta_context();

    view! {
        <Html attr:lang="en" attr:dir="ltr" attr:data-theme="light"/>

        <Title text="Musical Lights"/>

        <Meta charset="UTF-8"/>
        <Meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <Meta name="description" content="See your sound in a calm, colorful audio spectrum."/>

        <Meta property="og:type" content="website" />
        <Meta property="og:url" content="https://blink.stitthappens.com" />
        <Meta property="og:site_name" content="Stitt Happens" />
        <Meta property="og:locale" content="en_US" />

        <div class="site-shell">
            <Router>
                <header class="site-header">
                    <span class="wordmark"><span aria-hidden="true" class="brand-mark">"▂▅▃▆"</span>" STITT HAPPENS"</span>
                    <nav aria-label="Main navigation">
                        <A href="/" exact=true>"Home"</A><A href="/about">"About"</A>
                    </nav>
                </header>
                <main>
                    <Routes fallback=NotFound>
                        <Route path=path!("/") view=Home />
                        <Route path=path!("/about") view=About />
                    </Routes>
                </main>
                <footer>"Made for music, built with Rust. "<a href="https://github.com/BlinkyStitt/musical-lights-rs">"View the source ↗"</a></footer>
            </Router>
        </div>
    }
}
