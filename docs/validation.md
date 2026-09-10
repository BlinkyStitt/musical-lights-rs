# Validation record

Validated on 2026-09-10 on an Apple M4 Max Mac. The complete `python3 validation/validate.py all` command passed again after the microphone repair, page redesign, and final layout choice: 24 separate web/terminal bands and the preserved 20-row LED panel. All nine package roots passed their checks and release builds. Both GitHub workflows passed at commits `6802973`, `cfca78c`, `d9a71ef`, `de3db52`, and `4331b54`. After adding rainbow bars, `python3 validation/validate.py core leptos browser` passed again.

## Exact tools

- Host and ARM/WASM compiler: `nightly-2026-09-10`, `rustc 1.100.0-nightly (a36d05efa 2026-09-09)`. The official nightly channel manifest returned this date during the final review.
- Xtensa compiler: named toolchain `esp-1.98.1.0`, `rustc 1.98.1-nightly (183f762d6 2026-09-08) (1.98.1.0)`, LLVM 21.1.3. Installed with espup 0.17.1 and an explicit toolchain version. The generated environment file was loaded for both ESP package roots.
- ESP-IDF `v6.1`, with the three coordinated Git revisions in the [dependency inventory](dependencies.md).
- Trunk 0.22.0-beta.5, Dioxus CLI 0.8.0-alpha.1, wasm-bindgen CLI 0.2.128, Node 26.8.2, Playwright 1.64.0-alpha-2026-09-10 with its matching Chromium.
- actionlint 1.7.12 accepted both GitHub workflows. Python scripts passed compilation checks; JavaScript modules passed Node syntax checks.

The scripts run Cargo from each package directory with its pinned toolchain and `--locked`. The CLI builds use the package toolchain files. All active nightly configuration pins agree, and `rustup override list` reports no overrides.

## Results

| Package | Passed checks |
| --- | --- |
| Core | 32 tests in each of four feature combinations; six additional feature combinations under Clippy; all targets under Clippy; release cost measurement |
| Terminal | Three callback/downmix tests; Clippy for all targets; release build of all binaries and examples; bounded microphone and display check |
| Leptos | Eight display timing, live-level floor, and FPS tests; host test and WASM Clippy; Trunk release build; browser routes, microphone denial, live audio above nominal full scale at 44.1/48 kHz, stop, route cleanup, and late permission cleanup |
| Dioxus | WASM Clippy; matching CLI release build; visible page rendering and six links |
| Standalone WASM | WASM Clippy; complete `build.py`; browser execution of the shared-memory worklet with nonzero oscillator output |
| Feather M0 | `thumbv6m-none-eabi` Clippy; release link with panic-halt and with semihosting |
| STM32 | `thumbv7em-none-eabihf` Clippy and release links for all five binaries |
| ESP Embassy | `xtensa-esp32-none-elf` Clippy and release links for the application and priority example |
| ESP-IDF | `xtensa-esp32-espidf` Clippy and release link with ESP-IDF v6.1 |

All 15 browser tests passed. They use real browser AudioContexts and AudioWorklets. The live audio tests replace microphone acquisition with an oscillator stream at gain 4 and verify that samples above 1 reach the real worklet callback without an error. Separate input-worklet checks cover absent input, channel cancellation, extreme finite PCM, and block lengths of 64, 128, 256, and 511 samples. Tests confirm immediate context closure when a route closes before permission resolves, then stop any stream supplied later.

Page checks cover all 24 separate meters and five bass labels, stable DOM nodes, silence, error recovery, centered layouts at 375/768/1440 pixels, no horizontal overflow, text contrast, reduced motion, and rapid audio with queued callbacks. The complete graph is visible without scrolling at these sizes, and descriptive text follows it. Tests check Quiet/Loud labels, every band's exact frequency tooltip, keyboard focus, and removal of the counter and pause/resume controls. Screenshots were inspected, including color-vision simulations. The layout and contrast checks cover both system color schemes at all three widths. Text contrast is at least 4.5:1, and meter contrast against the graph is at least 3:1. Tests switch the system theme in both directions while the page stays open and confirm that the meter nodes remain intact.

All 24 bars now use the shared rainbow gradient, from red bass to purple treble.
Its HSLuv hue range is 12–285 degrees; the old endpoint of 255 stopped at blue.
Native tests check the red and purple endpoints and 24 distinct colors. Browser
layout tests send noise through a real AudioWorklet so every bar is visible. They
check all 24 fill colors for 3:1 contrast in each theme, matching baseline colors,
and fixed colors across audio updates and system theme changes. CSS explicitly
uses the shared gradient's linear sRGB encoding. Phone and desktop screenshots
show the rainbow with the existing compact layout, motion, tooltips, and FPS display.

Bars rise on the next screen frame without CSS easing. A new peak holds for 350 ms, then follows a critically damped fall that slows before reaching its live band level. Reduced Motion halves the release speed instead of using a single-step drop. The latest level remains valid between audio callbacks, so an absent callback cannot pull the bar below the live level. Native tests cover exact release timing at 30/60/120/144/240 Hz, short taps, braking when the floor rises during a fall, and reduced motion. FPS tests count actual elapsed animation intervals, including stalls. The browser compares the visible counter with independent animation timestamps while audio callbacks are suspended. The browser checks the actual rendered fast attack, retained live level, continuous fall to silence, and repeated queued taps at 100 heights in every band. The hold limits repeated flashes to at most three in any second, using the [WCAG flashing frequency limit](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes.html) as the design criterion. These checks do not provide a medical safety guarantee. Resource tests also verify that animation requests stop on microphone denial, Stop listening, route closure, and closure while permission remains pending.

Core tests cover all 24 center frequencies and unity stage gain at 44.1/48 kHz, separate outputs including every bass band, rejected input without state changes, silence, zero range, bounded output, sample-duration envelope timing, fractional LED decay to zero, actual frame writes, FFT frequency detection, gradient boundaries, and message CRC/COBS bounds. New tests preserve the expected level ratio above nominal full scale, keep extreme finite transients bounded, and compare changing-level filter history against an unscaled reference. The panel test checks the original five-band sum before normalization and all 19 remaining outputs. Firmware asserts that 20 rows of 20 pixels fill exactly 400 pixels, and retains the row-based scroll step.

The processor returns one borrowed `BarkFrame`. Its `bands()` output serves the website and terminal; `panel_rows()` serves the fixed LED geometry. Both use the same normalization function and the same filter/envelope state. The panel does not average already-normalized web values or use 16/17-pixel band segments.

The earlier range check incorrectly treated nominal PCM full scale as a hard limit. [Web Audio permits values outside that range](https://www.w3.org/TR/webaudio/#AudioBuffer). The processor now scales each block and its carried filter state, runs the biquads in f32, and restores physical level in f64 before compression. It does not clip finite PCM. Empty and non-finite input still fail before state changes.

Core test combinations are default, `std,log`, `libm,log`, and `libm,alloc,log`. Clippy also checks `libm`, `libm,alloc`, `libm,log`, `libm,defmt,embassy`, `libm,alloc,defmt,embassy`, and `std,alloc,log,defmt,embassy`. Rust warnings are denied for these checks and the other packages except ESP-IDF.

## Display motion and FPS

A controlled Chromium comparison used the same 1 kHz tap in both versions:
20 blocks of 128 samples at gain 4, followed by a silent block. The audio context
was suspended before this input so ongoing capture could not change the release.
The capture read computed meter transforms on every animation frame for 2.2 seconds
with a 320-pixel graph. Both runs delivered 60.00 FPS and a 99th-percentile frame
interval of 16.67 ms. This isolates the release curve; it does not measure the
user's browser or prove that a physical display runs at 120 Hz.

| Motion preference | Old largest fall per frame | New largest fall per frame |
| --- | --- | --- |
| Normal | 12.10 px | 6.40 px |
| Reduced Motion | 174.35 px | 3.21 px |

The old free fall accelerated into an abrupt stop. Reduced Motion used one large
step. The new damped release slows near the live floor and brakes when that floor
rises during descent. Reduced Motion uses half the release rate. Both retain
immediate rises and the 350 ms peak hold. A numerical tail below 0.0001 of full
height settles exactly to the live level; this is less than 0.04 pixels.

The visible FPS counter measures animation intervals over at least one second,
including delayed callbacks. Native tests cover 30/60/120/144/240 FPS and a full
second stall. The browser test compares the counter with independent animation
timestamps while audio callbacks are suspended, checks a gentle landing, and
verifies that stopping clears the counter. The
[browser controls animation callback timing](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame).
The counter does not report audio block rate or physical GPU presentation.

## Microphone and terminal display

The latest ten-second microphone check received 3750 blocks at 48000 Hz. The input peak was 0.015137273. All 24 output values remained finite and bounded. The same `Bands` formatter used by the terminal visualizer printed 24 columns; this quiet input produced blank glyphs at its display scale. CPAL reported one buffer underrun/overrun during the check. The run then completed successfully, so this is functional evidence, not a claim of dropout-free capture.

## Processor cost and memory

`cargo run --release --locked --example bark_cost --features std,log` warms the processor with four seconds of contiguous two-tone PCM, then processes that data ten times. The input contains 80 Hz and 1 kHz components. Input construction is outside the timed section. Each measurement processes 40 seconds of audio. This is a host wall-clock processing measurement; it is not an ESP32 CPU measurement.

| Sample rate | Samples per block | Wall time per block | Fraction of real-time budget |
| --- | --- | --- | --- |
| 44100 Hz | 128 | 8.76 us | 0.30% |
| 44100 Hz | 794 | 53.60 us | 0.30% |
| 48000 Hz | 128 | 9.22 us | 0.35% |
| 48000 Hz | 794 | 54.10 us | 0.33% |

`size_of::<BarkBank>()` is 2032 bytes on this host. Processing allocates no heap storage and uses a 128-sample scratch array plus 24 mean-square accumulators (608 bytes before compiler optimization). This size excludes caller-owned input/output buffers, other stack variables, browser resources, and firmware drivers. Total firmware memory and CPU cost still need measurements on each device.

## Warnings and local setup

ESP-IDF Clippy and linking report 32 warnings, mainly unused imports, variables, sensor state, and inactive pattern/UART code. These warnings remain visible. The validation script does not deny warnings for this package. The existing Embassy application also retains its existing allowance for unused development code.

Cargo reports manifest warnings for retained dependency declarations and binary names. Leptos dependencies `attribute-derive-macro 0.10.5` and `proc-macro-error2 2.0.1` report future Rust incompatibility warnings. The current pinned compiler still builds them successfully. These are not claims of compatibility with a later compiler.

GitHub also reports [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) for `glib 0.18.5` in the optional Dioxus Linux desktop dependency graph. The pinned newest Dioxus pre-release still brings this version through its GTK stack. The selected web target does not include `glib`; the independent lockfile records optional desktop dependencies too. This upstream desktop issue remains unresolved. No older dependency selection or compatibility patch hides it.

The terminal release examples link SDL2 from `/opt/homebrew/opt/sdl2/lib`. Local ESP-IDF setup exposed a broken Homebrew Python 3.14.7 `pyexpat` reference to the macOS system libexpat. Installing expat 2.8.4, updating that extension's library reference, and signing the extension repaired the host Python environment. The original extension was saved in `/tmp/musical-pyexpat-original.so`. The application contains no workaround for that local installation fault.

## Hardware limits

No ARM or ESP32 boards were available. No firmware was flashed. Successful links do not prove microphone sampling, sensor readings, LoRa exchange, LED signal quality, or real-time operation on hardware. The [LED timing review](led-timing.md) records source evidence, selected timing, and the remaining physical checks.

The Feather application still contains initialization only. The Embassy radio task remains a placeholder; its sensor initialization and I2S/LED tasks remain in the application. STM32 GPS and radio tasks still contain existing `todo!()` calls and will panic if reached after the sensor handshake. This upgrade does not claim to implement those unfinished functions.

The standalone worklet requires shared WASM memory, rebuilt standard library atomics/TLS exports, and cross-origin isolation headers. The browser tests serve the required headers. Ordinary static hosting without those headers is not a supported worklet deployment.

CI covers every package root plus the browser tests. The smoother-fall and FPS update at `4331b54` passed [all-root validation](https://github.com/BlinkyStitt/musical-lights-rs/actions/runs/34471359337) and [Pages deployment](https://github.com/BlinkyStitt/musical-lights-rs/actions/runs/34471359398). The live page also passed a Chromium check with real worklet peaks above one, 24 meters, centered layout, route navigation, stream cleanup, and displayed FPS matching measured animation intervals. Check the rainbow commit's workflow results and live page after push.
