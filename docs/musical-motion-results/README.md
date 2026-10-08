# Controls, recognition, and musical motion

Home and Advanced share Listening, Identify song, Phone motion, Scroll lights,
Video, and Fullscreen in one control grid. Labels open help on hover, focus, or
tap; routine microphone state appears there. Recovery notices remain visible.
Advanced puts source/file selection and digital transport above the visualization.
Display, Input & calibration, Physics, Diagnostics and Song history start closed
below it. Home keeps its educational content and omits FPS. `/advanced` remains
available; `/phone` retains ordinary not-found behavior.

Music/file selection starts digital playback with Listening off. Generated tones
wait for Play audio. PCM and channel selection are preserved. Replacement first
stops the prior owner and releases buffers; route exit releases the selected file.
Fullscreen can start the selected microphone and preserves digital playback.
It reserves space for the bottom controls, one song footer, and recovery notices.
The video sits above the scene in portrait and beside it in landscape.
Reset actions retain their separate scopes and physics durations use milliseconds.

## Shared embedded implementation

Reusable calculations live in `musical-lights-core`, with fixed storage and
`no_std` support: `audio::tempo`, `lights::dance`, `lights::musical_motion`, and
`lights::bar_motion`. Applications adapt those calculations to hardware or
Rapier/rendering. The idle travelling wave also lives in the core; its browser
worker calls a small WASM adapter without creating an audio processor or requesting
a microphone. The core uses no Web APIs, engine types, or new DSP dependency.
The new tempo stream leaves loudness/filtered-target transports unchanged.

Firmware can feed each existing 2 ms novelty frame to `TempoEstimator::push`,
read `estimate()` without allocation, and pass its BPM to `DanceMotion::advance`
with the hardware update duration. Feed genuine attacks and unscaled loudness to
`RecentPeak`; call `DanceMotion::choose` only for an accepted crest. Firmware can
instead supply its own random draw through `choose_draw`. `IdlePeak` owns separate
synthetic history. `idle_wave` takes column count and elapsed
seconds; the bar controller owns fixed arrays. Browser source acquisition,
permissions, song uploads, Rapier bodies, shaders and light objects stay in their
platform adapters. The hardware core has no dependency on those packages.

Scrolling follows the smoothed tempo at an average of two columns per beat:
four columns per second at 120 BPM, twice the initial PR speed. Direction changes
require a qualifying new recent loud attack. The default horizontal reversal chance
rises from 5% at 60 BPM to 50% at 200 BPM. Advanced Display exposes the BPM
thresholds, probabilities and curve exponent. Both bar banks now grow inward
together; they do not alternate between floor and ceiling.
There is no timed reversal. Idle motion can draw after a completed wave cycle,
using separate crest history. The core excludes Reduced Motion pauses from that
cycle clock. Position stays continuous through tempo changes. Reduced
Motion disables automatic travel. The rate is defined in the shared core, so
embedded displays and the browser adapter use the same motion.

See [YouTube and dance controls](../youtube-dance.md) for the current layout,
flight budget, camera controls, saved preferences, and release evidence. The
older validation records below describe their recorded revisions.

The estimator aggregates existing 2 ms spectral novelty into a 50 Hz envelope.
It retains eight seconds (400 f32 values), evaluates after four seconds every
half-second, searches 60–200 BPM using normalized mean-centered onset
correlation, rejects weak/nonperiodic evidence, and favors continuity at ambiguous
octaves. Accepted tempo enters a three-second time-based EMA; lost confidence
holds for two seconds before smoothly returning to 60 BPM. Startup and silence
use 60 BPM; the octave-search prior stays at 120 BPM to avoid interpreting
180 BPM clicks as 60 BPM. The page hides the counter when audio stops and marks
uncertain active estimates in its help text. It estimates tempo,
not beat timestamps, and makes no promise of correct metrical interpretation for
all music. A startup interpretation can differ from a listener's half/double tempo.

The design uses the autocorrelation idea in
[Ellis (2007)](https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf), not
its noncausal dynamic-programming beat path. Inspected alternatives were unsuitable
as direct embedded dependencies:

- [BTrack C++ source](https://github.com/adamstark/BTrack/blob/master/src/BTrack.cpp)
  resizes vectors and uses FFT/resampling libraries; it is a causal design
  reference, without copied implementation code.
- [librosa beat source](https://github.com/librosa/librosa/blob/main/librosa/beat.py)
  operates on NumPy arrays with Python/Numba/SciPy machinery and offline paths.
- [Rust bpm-analyzer](https://github.com/apoint123/bpm-analyzer) exposes full-PCM
  analysis and dynamically stored beat results, rather than an allocation-free
  incremental novelty consumer. We retain the existing core math dependencies.

## Verification boundaries

Local compiler, core feature matrix, worklet, physics, browser, reference audit,
and offline evidence are recorded here after validation. The historical fixed-window
[audit](../audio-audit-results/README.md) is retained unchanged. Raw loudness,
filtered targets, rendered movement, output-clock estimates and the approximately
1.13-second full-height bar release remain separate quantities.

Routine recognition checks use mocks and native recording with a mocked endpoint.
The single-request live AudD check is separately invoked; no production uploads
are allowed from development. Physical-device and human-listening acceptance
remain pending: normal/fullscreen, rotation lock, Reduced Motion, shaking and
tilting on an actual iPhone, plus accents/swells/decay observations during playback.

The initial complete browser suite passes 359 checks with one opt-in recorder skip,
using the unchanged serial startup guard, one worker and zero retries. Its
offline harness passes all 58 tests. The optional canvas recorder passes when
invoked separately, with Listening off and recordings written to a temporary
directory. Earlier audio-gap and fixture-race runs are retained below. See
[functional validation](functional-validation.json).

The fullscreen/touch review follow-up scopes Exit's compatibility-click suppression
to its button and pointer, clears it on pointer/touch cancellation, and preserves
normal capture release and keyboard activation. Touch assertions capture the
frequency label from the actual native pointer-down target while scrolling stays
enabled. Four event-replay regressions fail before the repair; all eight new
gesture checks and all 69 offline harness checks pass afterward. The focused
Chromium/iPhone-profile WebKit run passes 32 checks, including native touch,
fullscreen transitions, and stopping Listening after Exit. Full-suite, CI and
deployment results are reported separately in
[PR #39](https://github.com/BlinkyStitt/musical-lights-rs/pull/39) and its Actions runs.

The faster-scroll follow-up passes all 64 core tests in each of four feature
configurations, all 40 physics tests, and the worklet/Leptos checks. Its focused
Chromium, WebKit and iPhone-profile WebKit run passes all 79 checks with the
serial startup and crash guards intact, including expensive-step scheduling,
fullscreen snapshot age, wall containment, native touch and Reduced Motion.
The refreshed identical-PCM image previews record roughly 60 FPS on this Mac
with scrolling enabled and disabled; see each browser's `render-cost.json`.
These short digital-music runs do not qualify as phone FPS acceptance. Full-suite
and current-head CI results remain separately reported in the PR.

The first complete faster-scroll run passed 360 checks, skipped the opt-in
recorder, and failed one hover fixture at a subpixel seam fragment. A deterministic
production-layout regression fails in both browsers with the old helper. The
repair selects the wider visible portion of the same source, including its
wrapped copy, and waits for the stop transition in stationary layout tests.
All 92 focused layout/theme, native hover, keyboard, touch, physics and fullscreen
checks pass afterward. The two MP4 previews are refreshed for the faster build
and contain identical licensed audio packets; their timing remains approximate
recording evidence, separate from output-device latency and FPS acceptance.

Initial core validation passed 63 tests in each of four feature configurations, including
four tempo tests and reusable bar-motion/scroll/drag/pigment checks. The core also
compiles for actual `thumbv6m-none-eabi` and `thumbv7em-none-eabihf` targets with
`--no-default-features --features libm`; hardware execution remains unmeasured.
The standalone physics suite passes 40 tests, including containment, contact
history, tempo continuity and comparison with independent quadratic-drag formulas.

`validation/partial/tempo.mjs` compared six three-second fixtures against the saved
pre-tempo production WASM: all 9,000 complete diagnostic rows were bit-identical.
Actual PCM click trains converge within 5 BPM of 60, 90, 120, 150, 180 and 200 BPM.
The two short repeated licensed excerpts did not pass confidence gating and
retained the 120 BPM fallback. This limitation is visible in
[tempo observations](tempo-observations.json), without claiming music accuracy.
The warmed 1,640-byte estimator processed 52 seconds of envelope input in 1.552 ms
on this Mac (0.0030% host CPU; worst push 0.012 ms). These timings exclude FFT work
and do not measure a microcontroller.

The broader current-build comparison also reproduced 38 complete traces against
main, including licensed PCM, noise/masking/boundary fixtures and Reduced Motion.
All raw measurements, filtered targets and flash events are bit-identical;
diagnostic buffers remain absent until enabled. The reference audit reproduces
historical measurements unchanged, with current artifact hashes updated.

## Physical-device and listening checklist

| Check | Evidence still required |
| --- | --- |
| Normal, portrait fullscreen, landscape fullscreen | Three complete diagnostics-off five-minute exercise reports and smooth-motion confirmation on the actual iPhone |
| Rotation lock | Portrait and landscape controls, geometry, screen-angle diagnostics and exit behavior |
| Reduced Motion | Automatic scrolling disabled, additional pigment drift stopped, readable ring/title, normal and fullscreen views |
| Shaking and tilting | Native permission state, gravity/linear readings, tilt-only enable/stop, independent Listening and Phone motion shutdown |
| Human listening | Timestamped accents, swells and decay observations using licensed excerpts or private local files, with playback-device details |

No live AudD request was made for this change. Its separately invoked script
remains outside the routine mock suite. No firmware was flashed, and compiling
the reusable core for ARM does not establish microcontroller execution cost.

## Reproduce the evidence

Run from the repository root with the pinned tools on `PATH`. Browser commands
on macOS require host access and retain the serial startup guard, one worker and
zero retries. Complete offline CPU checks before running real-time browser checks.

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py core worklet physics leptos reference
node --test validation/harness/*.test.mjs
node validation/partial/current-build.mjs /path/to/main/pkg/loudness.wasm
node validation/partial/tempo.mjs /path/to/main/pkg/loudness.wasm
python3 validation/validate.py browser
node validation/phone-timing.mjs https://musical-lights.test docs/musical-motion-results
node validation/musical-previews.mjs
```

The optional video recorder requires FFmpeg and encodes the audio once before
copying the same packets into both MP4s. Recording and encoding do not qualify
as FPS acceptance or output-device latency measurements.

## Diagnostics-off host timing

Each layout uses five seconds of warmup and thirty seconds of measured repeating
24-tone exercise PCM through the real AudioWorklet and physics worker. All six
runs pass the existing numeric thresholds with diagnostic recording off and no
discarded simulation time. These short Mac measurements do not establish the
five-minute physical-phone or human smooth-motion result. Build identity,
timestamps, workload and output-clock confidence are retained in
[browser timing](browser-timing.json); detailed samples are in
[browser-timing-detail.json.gz](browser-timing-detail.json.gz).

| Mac browser | View | FPS | p95 frame (ms) | Maximum debt (ms) |
| --- | --- | ---: | ---: | ---: |
| Chromium | normal | 60.00 | 16.70 | 6.93 |
| Chromium | portrait-fullscreen | 60.00 | 16.70 | 6.27 |
| Chromium | landscape-fullscreen | 60.00 | 16.70 | 6.67 |
| iPhone-profile WebKit | normal | 60.00 | 18.00 | 6.67 |
| iPhone-profile WebKit | portrait-fullscreen | 60.00 | 18.00 | 9.67 |
| iPhone-profile WebKit | landscape-fullscreen | 60.00 | 18.00 | 6.67 |

The final matrix verifies 390 × 844 portrait and 844 × 390 landscape viewports,
with 2.597 m and 0.555 m fullscreen enclosure heights. Chromium uses its native
fullscreen path and WebKit uses the phone expanded-page path. GPU identity is
recorded, including Chromium’s SwiftShader software renderer.

The separate music-preview measurements record CPU draw submission and browser
frame pacing; music is not the phone acceptance workload. The lit scene uses
seven draw submissions (two instanced meshes, four walls, one enclosure line).
No shadow maps or bloom are enabled. Render submission time excludes GPU
completion. See the Chromium and WebKit `*-render-cost.json` files for those
observations, including WebKit's wider-view frame pacing limitations.

## Identical-audio previews

- [Scrolling with audio](scrolling-with-audio.mp4)
- [Stationary columns with the same audio](stationary-with-audio.mp4)
- [Angled lighting and contact pigments](chromium-scrolling-angled-swirl.png)

Both four-second MP4s use the first four seconds of the existing mono 48 kHz
licensed trumpet excerpt, encoded once and copied without gain changes into
each video. Audio packet hashes and the source PCM identity are recorded in
[video metadata](video-previews.json). Synchronization uses an approximate
recording-start clock; it is not output-device latency evidence. The recorder
uses expanded page fullscreen to keep its capture viewport stable.

Audio: “Jazz Trumpet Loops Pack in F 90 bpm” by
[Mihai Sorohan](https://freesound.org/s/77711/),
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
The repository audit excerpt retains its documented mono/48 kHz conversion and
fixed peak 0.2. No private local file or microphone audio is published here.

## Rendering and timing investigation

The earlier standard-material native Chromium landscape run reached 57.10 FPS
and failed the unchanged gate. Its [record](standard-native-timing.json) is
retained alongside [fullscreen controls](fullscreen-pacing-control.json).
Chromium reported a SwiftShader software GPU; blank and render-disabled controls
held 60 FPS, as did the lit expanded-page view. Bars, balls and enclosure now use diffuse
Lambert lighting to reduce shader work. Contact patterns remain in object coordinates.
Both browser engines pass the framebuffer checks for source colors, dark borders,
white highlights, side-face illumination and nearby attack lights.

A subsequent native portrait run exposed a separate clock-domain error, retained
in [frame-clock-failure.json](frame-clock-failure.json). Animation-frame timestamps
can precede actual callback execution. Physics and snapshot receipts use the
monotonic clock. The renderer now uses `performance.now()` for its input/presentation
timing, snapshot age and sensor age; reports compare physics progress with that
same clock. Animation-frame timestamps remain the frame-interval measure. A
regression deliberately separates the clocks and checks both contracts. No fixed
offset, gain or acoustic trace shift is applied, and the acceptance thresholds
are unchanged.

One complete functional run passed 358 checks with one skip and one failure
caused by a native [128-sample audio-clock gap](audio-clock-gap.json). The app
stopped that discontinuous session and showed recovery; the test could no longer
click Stop. The unchanged focused Stop regression then passed. No callback-gap
protection, test threshold, startup guard, worker count or retry setting was relaxed.

A separate full run exposed a test fixture race: it compared a newly received
contact history with the preceding rendered frame. The fixture now draws the
current snapshot synchronously before comparing pigment attributes. It retains
all independent pixel, lighting, side-face and Reduced Motion assertions.
