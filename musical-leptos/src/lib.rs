use leptos::*;
use leptos_meta::*;
use leptos_router::*;

mod components;
mod dependent_module;
mod pages;
mod wasm_audio;

// Top-Level pages
use crate::pages::home::Home;
use crate::pages::not_found::NotFound;

/// An app router which renders the homepage and handles 404's
#[component]
pub fn App() -> impl IntoView {
    // Provides context that manages stylesheets, titles, meta tags, etc.
    provide_meta_context();

    view! {
        <Html lang="en" dir="ltr" attr:data-theme="light"/>

        // sets the document title
        <Title text="Musical Leptos CSR"/>

        // injects metadata in the <head> of the page
        <Meta charset="UTF-8"/>
        <Meta name="viewport" content="width=device-width, initial-scale=1.0"/>

        // <Router>
        //     <Routes>
        //         <Route path="/" view=Home/>
        //         <Route path="/*" view=NotFound/>
        //     </Routes>
        // </Router>

        // TODO: figure out how to get the router working on github pages. i thought public url would do it
        <Home />
    }
}
