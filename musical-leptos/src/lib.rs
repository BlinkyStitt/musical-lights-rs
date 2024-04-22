use leptos::*;
use leptos_meta::*;
use leptos_router::*;

mod components;
mod dependent_module;
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
        <Html lang="en" dir="ltr" attr:data-theme="light"/>

        <Title text="Musical Lights"/>

        <Meta charset="UTF-8"/>
        <Meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <Meta name="description" content="Make some lights blink to your microphone."/>

        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://blink.stitthappens.com" />
        <meta property="og:site_name" content="Stitt Happens">
        <meta property="og:locale" content="en_US">

        <div class="container">
            <Router fallback=move || NotFound().into_view()>
                <nav>
                    <A href="">"Home"</A> - <A href="about">"About"</A>
                </nav>
                <Routes>
                    <Route path="/" view=Home />
                    <Route path="/about" view=About />
                </Routes>
            </Router>
        </div>
    }
}
