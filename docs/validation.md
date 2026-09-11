# Validation record

The current measurement contract and its limits are in [Audio, loudness, and light](loudness.md). The former empirical Bark processor and its 20 ms window are removed. Its previous test counts and timing measurements do not validate this implementation.

## Reproduce

Use the pinned tools in the README. The ISO validator requires Python 3.13 or newer and uv (tested with 0.10.5). On macOS, load the ESP toolchain environment and provide SDL2's library path for the terminal examples. Browser validation installs and runs both Chromium and WebKit.

```sh
python3 validation/validate.py all
```

Individual targets are `core`, `worklet`, `terminal`, `leptos`, `dioxus`, `wasm`, `feather`, `stm32`, `esp-embassy`, `esp-idf`, `reference`, and `browser`. Build the three web applications before running browser tests. `reference` installs its locked Python environment, checks the validation tools, builds `loudness_trace`, and runs the ISO and MoSQITo comparisons.

For Codex on macOS, run `python3 validation/validate.py browser` with approved host access (`sandbox_permissions: "require_escalated"`). The filesystem sandbox can block browser service registration even when network access is enabled. Keep normal commands in `workspace-write` and permit approval requests with `approval_policy = "on-request"`; disabling the sandbox for the whole session is unnecessary. Project configuration cannot override a managed session policy. See [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security). A sandbox launch error alone does not establish that browser tests are unavailable: request host access and report its actual result.

## Software checks

All ten package validation targets passed on 2026-09-11, including formatting, Clippy, host tests and release links. The final suite passed 38 core tests in each of four feature configurations, eight terminal tests, one Leptos host test, two profile-tool tests, and 38 browser/worklet checks with the standard three-worker configuration. Additional core feature combinations passed Clippy. The release builds include both ESP-IDF binaries.

The full run initially stopped because `ty` selected the system Python environment. The runner now selects the locked reference environment explicitly and checks its own source too. The remaining `reference browser` targets then passed. Both review regressions failed against the reviewed implementation before the fixes.

The subsequent iPhone fullscreen repair passed the Leptos validation target and all 41 browser/worklet checks with three workers on 2026-09-11. The browser suite now includes WebKit with an iPhone 13 device profile. The new regression reproduced the disabled button against the prior release build. It checks touch entry and exit, portrait and landscape viewport sizes, uninterrupted live audio, scroll restoration, route cleanup, and a rejected native fullscreen request. Chromium checks still require actual native fullscreen entry and browser-driven exit. Python lint, format and type checks for the changed runner also passed.

Fullscreen now expands the same graph into a lights-only page view on every browser. Where supported, the native API also hides browser chrome. The expanded view keeps an Exit button and hides the surrounding page and secondary controls. On iPhone Safari, the page cannot remove browser chrome through the unsupported element Fullscreen API; see [WebKit issue 206854](https://bugs.webkit.org/show_bug.cgi?id=206854). These WebKit tests run on the Mac. They do not verify a physical iPhone, Safari's address bar, or device safe-area insets.

## Measurement evidence

The unchanged ISO supplementary archive has SHA-256 `d17b2c6d66a28550ed145c3e1ae5af6ee5917b90e584358285686b1fc61edca7`. All twenty time-varying reference cases (6–25) passed the reference comparison. Every compared point was inside the inner tolerance. The largest total-loudness error was 0.017017 sone, in case 6. The comparisons against the separate MoSQITo Python implementation for cases 6, 10, 13 and 15 passed, including all 240 specific-loudness bins. Their largest total error was 0.023393 sone in case 15.

The checked-in [ISO report](loudness-results/iso.json), [MoSQITo report](loudness-results/mosqito.json), and plots for [cases 6](loudness-results/iso-6.svg), [10](loudness-results/iso-10.svg), [13](loudness-results/iso-13.svg) and [15](loudness-results/iso-15.svg) record this run.

Comparisons use the published time grid. No fitted level, time shift, or per-case gain is applied. Technical-sound worksheets omit a final incomplete 2 ms interval in some cases; the validator records that unmatched frame and retains it in the full stream/oracle checks. ISO signals remain outside version control. The validator verifies the original archive hash before use.

The shared model tests cover arbitrary callback partitions, a 10 ms tone burst, zero input, end-of-stream interpolation, exact sample timestamps, calibrated pressure units, non-finite input, missing samples, clipping reports, domain errors, and sustained 20/40/50/60/80 Hz tones. The review regression also checks a 30-second 50 Hz signal. The model emits identical sones and specific spectra for identical PCM divided into 1, 128, 800, whole-signal and irregular blocks.

Native tests check both signed 16-bit clipping rails and the production channel-selection path with opposite-phase stereo, preservation of all input samples, 44.1/48/96 kHz resampling amplitude and phase, callback partition roundoff, and rejection of a 30 kHz alias. Callback tests add timestamp jitter and millisecond rounding at 44.1/48 kHz, retain all three seconds of calibration samples, and verify the resulting pressure scale. A reported CPAL overrun keeps the stream failed even when data callbacks resume. These simulated callbacks do not validate physical ALSA devices. Color tests compare the reference HSLuv primaries, black and white, the sRGB transfer function, monotonic LED response, one application of correction, white balance, and the 128 drive cap. Profile-tool tests check inverse measurements and invalid data.

The motion tests cover 30/60/120/144/240 Hz sampling, short taps, stalls, live floors, fall braking, new peaks, white-edge decay, and combined bar/edge luminance reversals. Worklet tests verify the actual release WASM ABI, no module imports, bounded state transport, constant WASM memory after creation, channel selection, input failure, calibration across callbacks and host processing cost. Browser checks exercise real AudioContexts, live audio, calibration, capture settings, errors, stop/route cleanup, layout, color contrast, screen controls and share behavior.

The actual WASM producer receives a continuous 1 kHz tone at PCM amplitude 0.02 for 100 seconds. From 10 through 100 seconds, its strongest white edge remains at zero while gain raises the bar and measured loudness remains 4.957 sones. Doubling the input amplitude triggers a new edge. Core tests also check adaptive gain with Reduced Motion and preserve the acoustic input through snapshot serialization.

## Processing cost

An Apple M4 Max host processed warmed two-tone PCM through the loudness model, visual gain and producer motion state. Input construction and I/O were outside timing. Each measurement processed 40 seconds of audio:

| Input block | Wall time | Fraction of one host CPU core |
| --- | ---: | ---: |
| 128 samples | 0.2631 s | 0.658% |
| 768 samples | 0.2601 s | 0.650% |
| 800 samples | 0.2598 s | 0.650% |

`LoudnessMeter` occupies 4,824 bytes and requires no allocator. The warmed WASM producer processed four seconds of audio in 33.82 ms (0.846% of real time). Its separate WASM memory occupied 1,179,648 bytes and did not grow during the steady-state test. Each browser snapshot contains 146 `f64` values (1,168 bytes), including the acoustic input used by peak detection. JavaScript allocates the bounded display messages; the DSP callback does not allocate Rust buffers.

These are host measurements. They do not show ESP32 execution time or hardware accuracy. No board was flashed. Microphone calibration, I2S format, DMA stress, processing headroom, LED channel order, response curves, current draw and observed flicker remain bench checks. The LED thread explicitly reserves 16,000 stack bytes because its 4,800-byte linear palette exceeds the SDK default 3,072-byte thread stack. Actual stack high-water marks still require a board. The firmware exposes capture failures and includes a separate `light-check` program and profile generator for that work.
