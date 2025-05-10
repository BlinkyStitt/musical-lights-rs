use embassy_time::{Duration, Timer};
use esp_idf_svc::hal::task::block_on;

fn main() {
    // It is necessary to call this function once. Otherwise some patches to the runtime
    // implemented by esp-idf-sys might not link properly. See https://github.com/esp-rs/esp-idf-template/issues/71
    esp_idf_svc::sys::link_patches();

    // Bind the log crate to the ESP Logging facilities
    esp_idf_svc::log::EspLogger::initialize_default();

    log::info!("Hello, world!");

    block_on(async_main());
}

async fn async_main() {
    loop {
        println!("Hello from a task");
        Timer::after(Duration::from_secs(1)).await;
    }
}
