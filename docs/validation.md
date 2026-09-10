# Validation record

Validated on 2026-09-10 on an Apple M4 Max Mac. The complete `python3 validation/validate.py all` command passed after the final shared math, browser cleanup, ADC, and LED timing changes. The terminal checks also ran after the bounded microphone example gained display output.

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
| Core | 27 tests in each of four feature combinations; six additional feature combinations under Clippy; all targets under Clippy; release cost measurement |
| Terminal | Two callback/downmix tests; Clippy for all targets; release build of all binaries and examples; bounded microphone and display check |
| Leptos | WASM Clippy; Trunk release build; browser routes, counter, microphone denial, live reactive audio at 44.1/48 kHz, stop, route cleanup, and late permission cleanup |
| Dioxus | WASM Clippy; matching CLI release build; visible page rendering and six links |
| Standalone WASM | WASM Clippy; complete `build.py`; browser execution of the shared-memory worklet with nonzero oscillator output |
| Feather M0 | `thumbv6m-none-eabi` Clippy; release link with panic-halt and with semihosting |
| STM32 | `thumbv7em-none-eabihf` Clippy and release links for all five binaries |
| ESP Embassy | `xtensa-esp32-none-elf` Clippy and release links for the application and priority example |
| ESP-IDF | `xtensa-esp32-espidf` Clippy and release link with ESP-IDF v6.1 |

All eight browser tests passed. They use real browser AudioContexts and AudioWorklets. The live audio tests replace only microphone acquisition with an oscillator stream. Separate input-worklet checks cover absent input, stereo downmix, and block lengths of 64, 128, 256, and 511 samples. Tests confirm immediate context closure when a route closes before permission resolves, then stop any stream supplied later. Screenshots were also inspected for Leptos and Dioxus rendering.

Core tests cover all 24 center frequencies and unity stage gain at 44.1/48 kHz, the five-band bass sum and 20-output mapping, rejected input without state changes, silence, zero range, bounded output, sample-duration envelope timing, fractional LED decay to zero, actual frame writes, FFT frequency detection, gradient boundaries, and message CRC/COBS bounds.

Core test combinations are default, `std,log`, `libm,log`, and `libm,alloc,log`. Clippy also checks `libm`, `libm,alloc`, `libm,log`, `libm,defmt,embassy`, `libm,alloc,defmt,embassy`, and `std,alloc,log,defmt,embassy`. Rust warnings are denied for these checks and the other packages except ESP-IDF.

## Microphone and terminal display

The final ten-second microphone check received 3750 blocks at 48000 Hz. The input peak was 0.012168095. All 20 output values remained finite and bounded. The same `Bands` formatter used by the terminal visualizer printed 20 columns; this quiet input produced blank glyphs at its display scale. CPAL reported one buffer underrun/overrun during the check. The run then completed successfully, so this is functional evidence, not a claim of dropout-free capture.

## Processor cost and memory

`cargo run --release --locked --example bark_cost --features std,log` warms the processor with four seconds of contiguous two-tone PCM, then processes that data ten times. The input contains 80 Hz and 1 kHz components. Input construction is outside the timed section. Each measurement processes 40 seconds of audio. This is a host wall-clock processing measurement; it is not an ESP32 CPU measurement.

| Sample rate | Samples per block | Wall time per block | Fraction of real-time budget |
| --- | --- | --- | --- |
| 44100 Hz | 128 | 8.19 us | 0.28% |
| 44100 Hz | 794 | 46.14 us | 0.26% |
| 48000 Hz | 128 | 7.09 us | 0.27% |
| 48000 Hz | 794 | 43.46 us | 0.26% |

`size_of::<BarkBank>()` is 2020 bytes on this host. Processing allocates no heap storage. This size excludes caller-owned input/output buffers, thread stacks, browser resources, and firmware drivers. Total firmware memory and CPU cost still need measurements on each device.

## Warnings and local setup

ESP-IDF Clippy and linking report 32 warnings, mainly unused imports, variables, sensor state, and inactive pattern/UART code. These warnings remain visible. The validation script does not deny warnings for this package. The existing Embassy application also retains its existing allowance for unused development code.

Cargo reports manifest warnings for retained dependency declarations and binary names. Leptos dependencies `attribute-derive-macro 0.10.5` and `proc-macro-error2 2.0.1` report future Rust incompatibility warnings. The current pinned compiler still builds them successfully. These are not claims of compatibility with a later compiler.

The terminal release examples link SDL2 from `/opt/homebrew/opt/sdl2/lib`. Local ESP-IDF setup exposed a broken Homebrew Python 3.14.7 `pyexpat` reference to the macOS system libexpat. Installing expat 2.8.4, updating that extension's library reference, and signing the extension repaired the host Python environment. The original extension was saved in `/tmp/musical-pyexpat-original.so`. The application contains no workaround for that local installation fault.

## Hardware limits

No ARM or ESP32 boards were available. No firmware was flashed. Successful links do not prove microphone sampling, sensor readings, LoRa exchange, LED signal quality, or real-time operation on hardware. The [LED timing review](led-timing.md) records source evidence, selected timing, and the remaining physical checks.

The Feather application still contains initialization only. The Embassy radio task remains a placeholder; its sensor initialization and I2S/LED tasks remain in the application. STM32 GPS and radio tasks still contain existing `todo!()` calls and will panic if reached after the sensor handshake. This upgrade does not claim to implement those unfinished functions.

The standalone worklet requires shared WASM memory, rebuilt standard library atomics/TLS exports, and cross-origin isolation headers. The browser tests serve the required headers. Ordinary static hosting without those headers is not a supported worklet deployment.

CI now covers every package root plus the browser tests. Local validation and workflow syntax checks are complete; a GitHub Actions result must be checked separately after push.
