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
                    <p>"24 colorful bars bring your sound to life."</p>
                </section>
                <section class="how-it-works" aria-label="About the display">
                    <div><h3>"An easier pace"</h3><p>"Meters rise with each beat, then fall gently. Tap, hover, or focus the spectrum to see approximate frequency labels."</p></div>
                    <div><h3>"Your sound stays here"</h3><p>"Audio is processed in this browser. This page does not record or upload it."</p></div>
                </section>
                <section class="learning-topics" aria-labelledby="learning-title">
                    <h2 id="learning-title">"Things I learned along the way"</h2>
                    <p class="learning-intro">"Making lights dance led me through sound, color, electronics, and Rust. Here are some of the ideas I explored while building these projects."</p>
                    <div class="learning-grid">
                        <article class="learning-card">
                            <h3>"The Rust language"</h3>
                            <p>"The same language can handle a web page, a terminal, and tiny LED controllers. Ownership helps manage memory without a garbage collector."</p>
                            <div class="learning-links"><a href="https://doc.rust-lang.org/book/">"Read the Rust Book"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Hann windows"</h3>
                            <p>"Window functions taper the edges of a block of audio. The Hann window helps reduce artifacts when examining its frequency content."</p>
                            <div class="learning-links"><a href="https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.windows.hann.html">"Explore window functions"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Fast Fourier transforms"</h3>
                            <p>"An FFT separates a block of audio into frequency components. It is one way to turn a waveform into a spectrum."</p>
                            <div class="learning-links"><a href="https://numpy.org/doc/stable/reference/routines.fft.html">"Explore Fourier transforms"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Equal loudness & A-weighting"</h3>
                            <p>"Our ears respond differently to different frequencies. Equal-loudness contours describe that response, while A-weighting filters sound-level measurements."</p>
                            <div class="learning-links">
                                <a href="https://www.iso.org/standard/83117.html">"View ISO 226:2023"</a>
                                <a href="https://www.nti-audio.com/en/support/know-how/frequency-weightings-for-sound-level-measurements">"Learn about A-weighting"</a>
                            </div>
                        </article>
                        <article class="learning-card">
                            <h3>"Biquad filters"</h3>
                            <p>"A small digital filter can boost or reduce a range of frequencies. Combining filters gives more control over which parts of a sound pass through."</p>
                            <div class="learning-links"><a href="https://www.w3.org/TR/audio-eq-cookbook/">"Read the Audio EQ Cookbook"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Bitbanging, SPI & RMT"</h3>
                            <p>"Addressable LEDs need accurately timed bits. Bitbanging sends them in software; SPI and RMT peripherals can take over the timing."</p>
                            <div class="learning-links">
                                <a href="https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/spi_master.html">"Explore SPI"</a>
                                <a href="https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/rmt.html">"Explore RMT"</a>
                            </div>
                        </article>
                        <article class="learning-card">
                            <h3>"Color spaces: HSLuv & RGB8"</h3>
                            <p>"RGB8 stores red, green, and blue in three eight-bit channels. HSLuv makes it easier to choose colors with similar perceived lightness."</p>
                            <div class="learning-links"><a href="https://www.hsluv.org/">"Try the HSLuv color picker"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Splines & gradients"</h3>
                            <p>"Splines use control points to shape smooth curves. Those curves can guide how colors change through a gradient."</p>
                            <div class="learning-links"><a href="https://docs.scipy.org/doc/scipy/tutorial/interpolate/1D.html">"Explore spline interpolation"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Gamma correction"</h3>
                            <p>"Equal steps in an LED's output do not look equally bright. Gamma correction reshapes brightness values to make fades look more even."</p>
                            <div class="learning-links"><a href="https://learn.adafruit.com/led-tricks-gamma-correction">"Learn about LED gamma"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Level shifters"</h3>
                            <p>"A controller and an LED strip may use different signal voltages. A level shifter translates the data signal so the devices can communicate."</p>
                            <div class="learning-links"><a href="https://learn.adafruit.com/adafruit-neopixel-uberguide/logic-level">"Learn about level shifting"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Rust in the browser"</h3>
                            <p>"WebAssembly lets Rust run in a browser. wasm-bindgen connects that code to JavaScript and browser APIs."</p>
                            <div class="learning-links"><a href="https://wasm-bindgen.github.io/wasm-bindgen/">"Read the wasm-bindgen guide"</a></div>
                        </article>
                        <article class="learning-card">
                            <h3>"Reactive signals"</h3>
                            <p>"Signals hold values that can change. A reactive interface updates the parts of the page that depend on those values."</p>
                            <div class="learning-links"><a href="https://book.leptos.dev/reactivity/working_with_signals.html">"Learn about reactive signals"</a></div>
                        </article>
                    </div>
                </section>
            </div>
        </ErrorBoundary>
    }
}
