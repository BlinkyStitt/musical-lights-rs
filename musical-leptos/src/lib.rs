use leptos::prelude::*;
use leptos_router::{components::*, path};

mod components;
mod display;
mod pages;
mod screen;
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
    view! {
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
