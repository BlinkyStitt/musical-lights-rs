# Validation record

Validated on 2026-09-10 on an Apple M4 Max Mac. The complete `python3 validation/validate.py all` command passed again after the microphone repair, page redesign, and final layout choice: 24 separate web/terminal bands and the preserved 20-row LED panel. All nine package roots passed their checks and release builds. Both GitHub workflows passed at commits `6802973` and `cfca78c`. After the display response and compact layout changes, the affected Leptos checks and all 12 browser tests passed again.

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
| Core | 31 tests in each of four feature combinations; six additional feature combinations under Clippy; all targets under Clippy; release cost measurement |
| Terminal | Three callback/downmix tests; Clippy for all targets; release build of all binaries and examples; bounded microphone and display check |
| Leptos | Six display timing and live-level floor tests; host test and WASM Clippy; Trunk release build; browser routes, microphone denial, live audio above nominal full scale at 44.1/48 kHz, stop, route cleanup, and late permission cleanup |
| Dioxus | WASM Clippy; matching CLI release build; visible page rendering and six links |
| Standalone WASM | WASM Clippy; complete `build.py`; browser execution of the shared-memory worklet with nonzero oscillator output |
| Feather M0 | `thumbv6m-none-eabi` Clippy; release link with panic-halt and with semihosting |
| STM32 | `thumbv7em-none-eabihf` Clippy and release links for all five binaries |
| ESP Embassy | `xtensa-esp32-none-elf` Clippy and release links for the application and priority example |
| ESP-IDF | `xtensa-esp32-espidf` Clippy and release link with ESP-IDF v6.1 |

All 12 browser tests passed. They use real browser AudioContexts and AudioWorklets. The live audio tests replace microphone acquisition with an oscillator stream at gain 4 and verify that samples above 1 reach the real worklet callback without an error. Separate input-worklet checks cover absent input, channel cancellation, extreme finite PCM, and block lengths of 64, 128, 256, and 511 samples. Tests confirm immediate context closure when a route closes before permission resolves, then stop any stream supplied later.

Page checks cover all 24 separate meters and five bass labels, stable DOM nodes, silence, error recovery, centered layouts at 375/768/1440 pixels, no horizontal overflow, text contrast, reduced motion, and rapid audio with queued callbacks. The complete graph is visible without scrolling at these sizes, and descriptive text follows it. Tests check Quiet/Loud labels, every band's exact frequency tooltip, keyboard focus, and removal of the counter and pause/resume controls. Screenshots were inspected, including color-vision simulations.

Bars rise on the next screen frame without CSS easing. A new peak holds for 350 ms, then falls with increasing speed to its current live band level. The latest level remains valid between audio callbacks, so an absent callback cannot pull the bar below the live level. Native tests cover exact gravity timing across frame rates, short taps, changes in the floor, and reduced motion. The browser checks the actual rendered fast attack, retained live level, continuous fall to silence, and repeated queued taps at 100 heights in every band. The hold limits repeated flashes to at most three in any second, using the [WCAG flashing frequency limit](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes.html) as the design criterion. These checks do not provide a medical safety guarantee. Resource tests also verify that animation requests stop on microphone denial, Stop listening, route closure, and closure while permission remains pending.

Core tests cover all 24 center frequencies and unity stage gain at 44.1/48 kHz, separate outputs including every bass band, rejected input without state changes, silence, zero range, bounded output, sample-duration envelope timing, fractional LED decay to zero, actual frame writes, FFT frequency detection, gradient boundaries, and message CRC/COBS bounds. New tests preserve the expected level ratio above nominal full scale, keep extreme finite transients bounded, and compare changing-level filter history against an unscaled reference. The panel test checks the original five-band sum before normalization and all 19 remaining outputs. Firmware asserts that 20 rows of 20 pixels fill exactly 400 pixels, and retains the row-based scroll step.

The processor returns one borrowed `BarkFrame`. Its `bands()` output serves the website and terminal; `panel_rows()` serves the fixed LED geometry. Both use the same normalization function and the same filter/envelope state. The panel does not average already-normalized web values or use 16/17-pixel band segments.

The earlier range check incorrectly treated nominal PCM full scale as a hard limit. [Web Audio permits values outside that range](https://www.w3.org/TR/webaudio/#AudioBuffer). The processor now scales each block and its carried filter state, runs the biquads in f32, and restores physical level in f64 before compression. It does not clip finite PCM. Empty and non-finite input still fail before state changes.

Core test combinations are default, `std,log`, `libm,log`, and `libm,alloc,log`. Clippy also checks `libm`, `libm,alloc`, `libm,log`, `libm,defmt,embassy`, `libm,alloc,defmt,embassy`, and `std,alloc,log,defmt,embassy`. Rust warnings are denied for these checks and the other packages except ESP-IDF.

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

CI covers every package root plus the browser tests. The microphone and 24-band update at `cfca78c` passed [all-root validation](https://github.com/BlinkyStitt/musical-lights-rs/actions/runs/34464834026) and [Pages deployment](https://github.com/BlinkyStitt/musical-lights-rs/actions/runs/34464834053). The live page also passed a Chromium check with real worklet peaks above one, 24 meters, centered layout, route navigation, and stream cleanup. Check the next display commit's workflow results and live page after push.
