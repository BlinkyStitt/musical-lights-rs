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

Fullscreen expands the same graph into a lights-only page view on every browser. Where supported, the native API also hides browser chrome. Tap the visible Exit button at the top of the view, or press Escape; downward swipe or drag remains available where the browser delivers that gesture. The entry hint disappears after three seconds. On iPhone Safari, the page cannot remove browser chrome through the unsupported element Fullscreen API; see [WebKit issue 206854](https://bugs.webkit.org/show_bug.cgi?id=206854). The published fullscreen repair passed the iPhone WebKit check with 24 live bands, entry and exit, uninterrupted audio, and capture cleanup. The synthetic microphone source uses the `MediaDevices` prototype because an instance override did not survive the live page's load in WebKit. These WebKit tests run on the Mac. They do not verify a physical iPhone, Safari's address bar, or device safe-area insets.

The later mobile-controls and shorter-glow update passed the `core`, `worklet`, `leptos`, `terminal`, and `esp-idf` validation targets on 2026-09-11. Core ran 39 tests in each of four feature configurations. All 43 browser/worklet checks passed. A tapped band now has one readout above the graph with a matching color square and a fresh three-second timeout. Tests cover replacement and expiry, repeated taps, route cleanup, normal and fullscreen placement, keyboard access to Exit, downward drag, and rejected short, sideways, canceled and multi-touch gestures. The new glow test checks the damped decay curve and callback partitioning; the existing flash-limit and live-floor checks still pass. Timer tests use native browser timers: Playwright Clock's synthetic IDs exceed the Web IDL signed 32-bit timer handle and cannot test cancellation through the WASM binding.

The reported swipe failure exposed a gap in those 43 checks: the mobile helper dispatched untrusted pointer events directly to the graph. It bypassed browser touch processing, hit testing on bars, pointer capture, and cancellation. A browser-generated touch stream reproduced the premature frequency readout. The repaired handler owns both taps and swipes, captures the active pointer, and exits at 80 CSS pixels of predominantly downward movement without waiting for release. A completed touch with no movement beyond 10 pixels selects a band; dragging, scrolling, or cancellation cannot become a tap. The graph declares its touch behavior directly, retaining pinch zoom; see the [Pointer Events rules for capture and touch actions](https://www.w3.org/TR/pointerevents3/).

`touch-screen.spec.mjs` uses Chromium's browser input protocol to produce trusted touch events on a live bar, and checks exit before release, capture, uninterrupted audio, tap/drag separation, normal page scrolling, cancellation, and multi-touch. WebKit's Playwright transport supports touch taps but not touch drags; its tests now use real mouse drags for capture instead of fabricated touch events. WebKit still checks actual touch taps and three-second expiry. The Leptos validation target and all 47 browser/worklet checks passed on 2026-09-11. These checks do not replace testing on a physical iPhone.

Linux CI exposed a separate input-harness issue after the successful swipe: Chromium received the immediately injected Stop tap but suppressed its click. Waiting for the button result did not fix it. An isolated Linux image with the pinned Node and Playwright versions reproduced this on a plain HTML button and drag area without application code. A 200 ms gap between the swipe release and the next tap delivered the click; slower swipe movement alone did not. The regression allows 250 ms to lift and move the finger before tapping Stop once, then still requires the Start button and an ended microphone track. It does not retry the tap or bypass touch input. The corrected tests passed five consecutive Linux runs (20 touch checks), all 42 Linux Chromium checks, and all 47 Mac browser/worklet checks.

## Continuous browser spectrum

The 2026-09-12 change renders 240 accessible meters in 24 fixed color groups.
The core suite passed 48 tests in each of four feature configurations, plus all
feature-matrix Clippy checks. The worklet and Leptos validation targets passed,
including 27 Leptos host tests and release builds. Terminal tests (8), Clippy,
and release binaries/examples passed with the installed SDL2 library path.
Dioxus, standalone WASM, Feather M0, STM32, ESP Embassy, and ESP-IDF validation
and release builds passed. ESP validation used its installed compiler path,
Python 3.14, and libclang; ESP-IDF required host access for its component
manager process query. No firmware was flashed. All 72 browser/worklet checks
passed with the pinned tools and standard three-worker configuration. The suite
covers accessibility roles and labels, contrast, touch and keyboard readouts,
independent motion, grouped attack edges, malformed transport, 24-region sphere
physics, stronger gravity, and audio/route/fullscreen cleanup.

The [release comparison and screenshots](spectrum-results/README.md) record
actual desktop Chromium and Mac iPhone-profile WebKit frame delivery, transport,
decode/effects cost, memory, and delayed-UI recovery against PR #4. A separate
100-second release-WASM comparison confirms bit-identical aggregate output.
These results do not establish physical-device timing or production deployment.

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

`LoudnessMeter` occupies 4,824 bytes and requires no allocator. The warmed WASM producer processed four seconds of audio in 33.82 ms (0.846% of real time). Its separate WASM memory occupied 1,179,648 bytes and did not grow during the steady-state test. That earlier browser snapshot contained 146 `f64` values (1,168 bytes), including the acoustic input used by peak detection. JavaScript allocates the bounded display messages; the DSP callback does not allocate Rust buffers.

These are host measurements. They do not show ESP32 execution time or hardware accuracy. No board was flashed. Microphone calibration, I2S format, DMA stress, processing headroom, LED channel order, response curves, current draw and observed flicker remain bench checks. The LED thread explicitly reserves 16,000 stack bytes because its 4,800-byte linear palette exceeds the SDK default 3,072-byte thread stack. Actual stack high-water marks still require a board. The firmware exposes capture failures and includes a separate `light-check` program and profile generator for that work.
