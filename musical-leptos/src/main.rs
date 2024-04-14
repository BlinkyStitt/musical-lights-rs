use leptos::*;
use musical_leptos::App;

// When the `wee_alloc` feature is enabled, this uses `wee_alloc` as the global
// allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

fn main() {
    _ = console_log::init_with_level(log::Level::Debug);

    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    mount_to_body(|| view! { <App/> })
}
