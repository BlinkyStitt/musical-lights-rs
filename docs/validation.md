# Validation record

The current measurement contract and its limits are in [Audio, loudness, and light](loudness.md). The former empirical Bark processor and its 20 ms window are removed. Its previous test counts and timing measurements do not validate this implementation.

## Reproduce

Use the pinned tools in the README. The ISO validator requires Python 3.13 or newer and uv (tested with 0.10.5). On macOS, load the ESP toolchain environment and provide SDL2's library path for the terminal examples. Browser validation installs and runs both Chromium and WebKit.

```sh
python3 validation/validate.py all
```

Individual targets are `core`, `worklet`, `terminal`, `leptos`, `dioxus`, `wasm`, `feather`, `stm32`, `esp-embassy`, `esp-idf`, `reference`, and `browser`. Build the three web applications before running browser tests. `reference` installs its locked Python environment, checks the validation tools, builds `loudness_trace`, and runs the ISO and MoSQITo comparisons.

For Codex on macOS, run `python3 validation/validate.py browser` with approved host access (`sandbox_permissions: "require_escalated"`). The filesystem sandbox can block browser service registration even when network access is enabled. Keep normal commands in `workspace-write` and permit approval requests with `approval_policy = "on-request"`; disabling the sandbox for the whole session is unnecessary. Project configuration cannot override a managed session policy. See [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security). A sandbox launch error alone does not establish that browser tests are unavailable: request host access and report its actual result.

Run these commands from the repository root with `.tools/bin` on `PATH`:

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py leptos
python3 validation/validate.py browser
```

For a focused browser check, use host access with this command. Add test files,
`--grep`, or `--project` after the configuration path:

```sh
.tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.config.mjs
```

The repository's `.codex/config.toml` selects `workspace-write`, `on-request`,
and network access. `.codex/rules/browser-tests.rules` allows the two browser
command prefixes above outside the sandbox. Rules match command tokens; run
from the repository root so the relative paths select this repository's tools.
The Python prefix also matches extra validation targets after `browser`.

Codex loads trusted project configuration and rules at startup. Restart Codex
after changing them. Existing session or CLI overrides and managed restrictions
can still take precedence. See [configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic)
and [project rules](https://learn.chatgpt.com/docs/agent-configuration/rules).
Check the command matches without launching a browser:

```sh
codex execpolicy check --rules .codex/rules/browser-tests.rules -- python3 validation/validate.py browser
codex execpolicy check --rules .codex/rules/browser-tests.rules -- .tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.config.mjs --project webkit-spectrum
```

The rule file includes matching and nonmatching examples. Codex checks these
examples when it loads the file. Unrelated Python, Node, and shell commands do
not receive host access from these rules.

The browser and preview suites check startup serially before test workers start.
Each selected project must launch its configured browser, open a blank page,
and close the browser. A failure stops the run with a nonzero exit status and
the original browser error. This limits a startup failure to one failed launch
per invocation. The browser still needs the OS permissions described above.
`npm test` first runs harness regressions with a small executable that exits
unsuccessfully; these tests verify failure handling without crashing a browser.

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

### Browser startup crash investigation

The 2026-09-12 review rerun produced macOS crash notices before the application
loaded. Chromium's saved launch log reports `bootstrap_check_in` with
`Permission denied (1100)`, followed by `SIGTRAP`. WebKit aborted during macOS
application registration. These match the command sandbox restriction above.
The test runner then launched new browsers for subsequent tests despite the
same startup failure. With a controlled failing executable, the original
configuration made six launch attempts for six tests. The startup check now
stops after the first attempt, retains the error, and starts no test workers.
Separate regressions check selection of Chromium and WebKit with `--project`.

After the change, all three harness regressions, all 72 browser/worklet checks,
and the share-image preview check passed with the pinned tools. The browser
and preview runs used approved host access on the Mac. No new Chromium or
WebKit crash reports appeared during verification. These checks cover the
existing release builds; this change modifies the validation harness only.

### Spectrum keyboard access and Codex project rules

The 2026-09-12 keyboard fix passed pinned Leptos validation, including 27 host
tests, Clippy, formatting, and the release build. All 84 browser/worklet checks
and three startup harness regressions passed with host access on macOS. The
new Tab-stop regression first failed in Chromium and WebKit against the prior
release: it found 240 Tab stops instead of one.

Both engines now check all 240 samples in both arrow directions, direct Tab
exits, remembered focus, Home/End, endpoints, modified keys, visible focus,
mouse/touch readouts, fullscreen exit, and route cleanup. Screenshot checks
cover light and dark modes at 375 and 1440 CSS pixels. No new browser crash
reports appeared during validation.

Codex CLI 0.154.0 passed all 17 rule examples with `execpolicy check`. A fresh
local app-server session loaded the trusted project layer and confirmed
`on-request`, `workspaceWrite`, and network access without session overrides
or a model turn. These are local results; CI and deployment have separate
status.

## 24 rounded browser bars

The 2026-09-13 change returns the browser to the shared 24-band display and
doubles the decorative spheres from 12 to 24. The curved collision surfaces
use the same quarter-width corner radius as CSS. Collision substeps include
bar rise, so a fast attack cannot pass through a sphere. A full white overlay
uses the existing attack envelope and covers the colored baseline too.

Pinned `core`, `worklet`, `leptos`, and `wasm` validation passed locally. Core
ran 41 tests in each of four feature configurations and passed its Clippy
feature matrix. Leptos passed 29 host tests, host and WASM Clippy, formatting,
and its release build. New physics regressions reproduced vertical-only
corner rebounds and bars crossing spheres before the fixes.

All 92 browser/worklet tests passed with host access and the standard three
workers. Chromium and WebKit both check 24-bar geometry, full-height glow,
keyboard access, readout labels, fullscreen exit, and route cleanup. The suite
also checks 24 sphere bodies, separation against rendered rounded corners,
mouse and sensor input, touch gestures, and the three-second readout timeout.
No new macOS browser crash reports appeared during these checks.

A 100-second deterministic release-WASM comparison against PR #6 checked
37,500 snapshots and total sones. All 146 shared motion values remained
bit-identical. The browser now transfers only those 146 f64 values (1,168 bytes).
The 240 internal loudness samples remain part of the acoustic model.

The [release measurements](rounded-bars-results/current.json) used five seconds
of warmup and 30 seconds of real AudioWorklet input per browser. Desktop Chromium
delivered 60.00 animation frames/s; Mac WebKit with an iPhone 13 profile delivered
60.49. The 95th-percentile callback cost through queued microtasks was 4.24 ms
and 6.72 ms respectively. Both recovered after a deliberate 300 ms UI stall
with only one old packet. These are Mac measurements, not physical iPhone
measurements. The [desktop](rounded-bars-results/desktop.png) and
[mobile](rounded-bars-results/mobile.png) screenshots show the release app;
their FPS labels include the deliberate stall after the measurement window.
The share-image renderer also passed.

Linux CI exposed a test-fixture failure in the added WebKit audio checks:
garbage collection can discard an override on the native `MediaDevices`
instance. An explicit browser collection reproduced both startup failures
locally. Those fixtures now override `MediaDevices.prototype`, as the existing
iPhone checks do, and collect garbage before capture to preserve the regression.

These results describe local validation. CI and deployment have separate status.

## White inner-border correction

The follow-up on 2026-09-13 replaces the solid white fill from the preceding
release with a 1-pixel inner border. White follows the rounded top, both sides,
and bottom edge; the center keeps its rainbow color even at peak opacity.
The attack envelope, bar geometry, and sphere physics stay unchanged.

The new browser regression failed against the previous release because its
center was opaque white. After the CSS fix, all eight focused Chromium/WebKit
checks passed across light/dark themes and normal/Reduced Motion, both in the
page and fullscreen. They check transparent centers, fixed fill colors, all
four border widths and colors, matching corner radii, and unchanged dimensions.
The [desktop](inner-border-results/desktop.png) and
[mobile-size fullscreen](inner-border-results/mobile-fullscreen.png) screenshots
show the corrected release build at a test-injected attack peak. Both browsers
ran on macOS; the screenshots above this section show the earlier solid fill.

Pinned `core` validation passed 41 tests in each of four feature configurations
and its Clippy matrix. Its luminance regression now samples the side border,
moving top edge, colored center, and bottom baseline. Pinned `leptos` validation
passed all 29 host tests, formatting, host/WASM Clippy, and the release build.
The full host browser suite passed all 92 tests. No new browser crash reports
appeared. These are local results; CI and deployment have separate status.

The first Linux CI run then passed 91 browser tests and failed one peak-opacity
assertion: the wall clock had advanced past the hold before WebKit read the
synthetic frame. Deployment remained blocked. A deliberate 500 ms read delay
reproduced that failure locally. The fixture now advances its synthetic audio
clock explicitly through peak, fade, and rest, while retaining that delay.
All 92 browser tests passed locally after the repair; production timing is unchanged.

## Compact chart and compressible balls

The 2026-09-13 follow-up replaces headroom based on chart width with 5% of
chart height. LOUD, the top grid line, and the maximum bar height share that
inset in normal and fullscreen views. The normal chart no longer adds a second
area for large balls. The 24 bars, 24 balls, and 1-pixel white inner border remain.

Contact pressure changes a ball's width and height. It draws and collides as a
rounded capsule, then recovers its round shape as space opens. Contact response
also moves neighboring bodies. A compressed ball can pass through a real gap;
bar impacts still control color changes. WebKit rounded percentage centering
transforms, so the renderer now positions each body's exact bounds directly.
A visible minimum compression size could exceed a bar gap. The size floor now
serves only numerical stability. Pressure causes a smaller shape change as a
ball gets thinner.

Pinned `leptos` validation passed formatting, host/WASM Clippy, all 33 native
tests, and the release build. The native checks cover full-height bar pressure,
shape recovery, all 24 bars with narrow gaps, and 10,000 steps of bounded motion.

All 119 browser/worklet checks passed locally with three workers. The WebKit
project now includes the full ball suite. Checks cover 5% headroom, contact
geometry, compression and recovery at 375/1440 pixels in both motion settings,
mouse and sensor input, color persistence, keyboard access, labels, the inner
border, fullscreen exit, and audio/route cleanup. Mouse checks compare the same
crowd with and without input. Sensor fixtures dispatch their public event fields
in both engines; they do not depend on native constructors that WebKit forbids.

The [release measurement](compact-balls-results/release.json) ran five seconds
of warmup and 30 seconds of real AudioWorklet input per browser. Chromium and
the WebKit iPhone profile both held 60 FPS. Animation callback p95 was 2.03 ms
and 3.10 ms respectively; including queued microtasks gave 2.03 ms and 3.12 ms.
Both acknowledged every measured snapshot and recovered from a 300 ms page
stall with one old packet followed by current state. The 1,168-byte transport
and worklet memory size remained unchanged. No new browser crash reports
appeared during the local runs. The release screenshots follow the forced
stall, so their FPS labels include that interruption. These are local results;
CI and deployment have separate status.

Saved pressure and recovery images show the [desktop chart under pressure](compact-balls-results/desktop-compressed.png),
[desktop recovery](compact-balls-results/desktop-recovered.png),
[mobile WebKit pressure](compact-balls-results/mobile-webkit-compressed.png), and
[mobile WebKit recovery](compact-balls-results/mobile-webkit-recovered.png).
These are Mac browser checks, including an iPhone profile, rather than measurements
on a physical phone.

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
