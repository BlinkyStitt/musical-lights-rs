# Continuous spectrum validation — 2026-09-12

The browser now renders 240 loudness samples across the 24-Bark scale, spaced at
0.1 Bark. The samples form one filled spectrum in 24 fixed HSLuv color regions.
The shared loudness model, aggregate gain, terminal output, and LED output retain
their existing numerical contracts.

## Release comparison

The baseline is a clean `git archive` of PR #4's merge,
`4218d767ac4f247b5afaabe509bfe3ed93ae82db`. Both versions used the pinned release
build and the same measurement script. The reports record worklet and served
index hashes: [baseline](baseline.json), [continuous spectrum](continuous.json).
The final preview-asset rebuild changed only the ordering of modulepreload links
in the index. Reordering those links reproduces the recorded index hash exactly;
the worklet hash remains identical.

The [aggregate comparison](aggregate-equivalence.json) passed for **37,500
snapshots over 100 seconds of PCM**. All 146 aggregate values and total sones
matched the baseline bit for bit, including silence, changing levels, and
Reduced Motion changes. This compares the two actual release WASM modules.

Each browser run warmed for five seconds, then measured 30 seconds. The source
was a repeating, deterministic 48 kHz signal with two tones, low-level noise,
and slow amplitude changes. A real MediaStream fed the page's AudioContext,
AudioWorklet, transferred snapshot, Rust decoder, acknowledgement, animation,
and existing DOM nodes. No synthetic display messages supplied these timings.

| Mac browser profile | Version | RAF/s | Audio messages/s | Payload MB/s | Decode + ACK p95 ms | RAF through effects p95 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Desktop Chromium | PR #4 | 60.00 | 187.57 | 0.219 | 0.040 | 0.125 |
| Desktop Chromium | Continuous | 60.00 | 187.61 | 2.383 | 0.055 | 0.475 |
| iPhone-profile WebKit | PR #4 | 60.00 | 187.48 | 0.219 | 0.040 | 0.160 |
| iPhone-profile WebKit | Continuous | 60.00 | 187.61 | 2.383 | 0.040 | 0.440 |

The new p95 frame intervals were 16.67 ms in Chromium and 17.62 ms in WebKit.
The new p95 snapshot ages were 5.33 ms and 2.67 ms respectively. Each message
received an acknowledgement. Snapshot payload grew from **1,168 to 12,704 bytes**.
The table uses decimal MB and excludes the message envelope. Message rates use
actual packet counts divided by the observed frame window (about 29.98–30.00 s),
so endpoint differences can put the estimate slightly above 187.5/s. The 240 Hz
send cap with 128-sample quanta at 48 kHz permits a send every second quantum,
or 187.5/s. It does not imply 240 actual messages/s or follow screen refresh.

Timing wraps the actual message handler and application RAF callbacks. The
effects boundary includes the following microtask, where Leptos applies queued
work. It includes both sphere and spectrum callbacks as separate observations;
it does not measure GPU paint or physical display presentation. The instrumentation
also has overhead. These are single comparative host runs, not confidence intervals.

Both versions passed a deliberate 300 ms main-thread stall. Exactly one older
packet remained pending, then a current snapshot arrived after acknowledgement.
The producer did not replay the missed frames. The screenshot FPS counters can
show the intentional stall because screenshots follow that check.

The separate warmed Node WASM benchmark included processing, snapshot creation,
buffer detachment with `structuredClone`, and an ACK after each quantum. Thirty
seconds of audio took **291.10 ms baseline / 322.44 ms new**: **0.970% / 1.075%**
of one host core. Both worklet memories stayed at **1,179,648 bytes**. This is
host processing cost; the browser runs above measure asynchronous transport.

All measurements ran on an Apple M4 Max Mac, macOS Darwin 25.2.0, with Node
26.8.2 and Playwright 1.64.0-alpha-2026-09-10. The WebKit iPhone 13 profile runs
on the Mac. There is no physical iPhone, microphone, sensor, or board evidence.

## Visual and interaction checks

Reviewed actual served release screenshots and motion tests on desktop, 375 px
and 320 px layouts, portrait fullscreen, and 844×390 mobile landscape fullscreen.
The fine downward steps remain visible. Touching fills and fixed colors avoid
240 separate outlines; only the 24 faint separators and thin attack top edges
remain. Broadband, steady tone, quiet tone, silence, new peaks, and Reduced
Motion use the same scale and independent sample falls. No zoom was added.

- [Desktop release](continuous-desktop-chromium.png)
- [iPhone profile on the Mac](continuous-iphone-profile-webkit-on-mac.png)
- [320 px fullscreen](continuous-320-fullscreen.png)
- [Mobile landscape fullscreen](continuous-844-fullscreen.png)

At narrow widths a sample can occupy about one CSS pixel. Touch tests use the
actual browser hit point and verify its readout, color, timeout, and gestures.
Keyboard focus can select individual samples. Tests verify all 240 labels are
monotonic and preserve all integer-Bark endpoints, with 240 meters in 24 groups.
Contrast, fixed colors, top-edge-only geometry, fullscreen, and cleanup pass.

Sphere geometry uses 24 group containers. The unchanged aggregate frame drives
collisions, so a sphere can overlap the taller fine fill. The browser test proves
that a fine-only peak does not push or recolor a sphere and that an aggregate
rise still does. Gravity remains active with the microphone off. The new free-space
regression failed against PR #4 (0.272 graph height in half a second) and passes
the new minimum distances of 0.5 normally and 0.1 with Reduced Motion.

## Validation results

All repository targets for core, worklet, Leptos, terminal, Dioxus, standalone
WASM, Feather M0, STM32, ESP Embassy, and ESP-IDF passed their applicable checks
and release builds. Core passed 48 tests in each of four feature configurations,
Leptos passed 27 host tests, terminal passed 8, and the browser suite passed 72.
The share-image renderer also passed; its generated PNG now uses the actual
24 group colors. Existing dependency and macro warnings remain. The reference DSP algorithm did
not change; this task did not repeat the external ISO/MoSQITo reference corpus.

Terminal linking needed the installed SDL2 library path. ESP checks needed the
installed Xtensa tools, Python 3.14, and libclang. ESP-IDF's component manager
needed host access for its macOS process query. These were command environment
requirements; no firmware source or toolchain pins changed.

## Reproduction

Build the baseline in a separate directory. Keep the shared working tree intact.
Use the repository's pinned Rust, Trunk, wasm-bindgen, Node, and Playwright tools.

```sh
PATH="$PWD/.tools/bin:$PATH" python3 validation/validate.py core worklet leptos
cd validation
PATH="$PWD/../.tools/bin:$PATH" npm test
PATH="$PWD/../.tools/bin:$PATH" node measure-spectrum.mjs /path/to/baseline pr4 test-results/baseline.json
PATH="$PWD/../.tools/bin:$PATH" node measure-spectrum.mjs .. continuous test-results/continuous.json
PATH="$PWD/../.tools/bin:$PATH" node compare-spectrum-aggregate.mjs /path/to/baseline/musical-leptos/dist/loudness/loudness.wasm ../musical-leptos/dist/loudness/loudness.wasm
```

These are locally served release artifacts. Production deployment remains a
separate step after PR review, merge, and a successful Pages workflow.
