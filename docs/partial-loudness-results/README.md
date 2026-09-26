# Source-band loudness and 40 ms strokes

The complete Mac Chromium/WebKit suite passes **158 checks** after the session and fixture
repairs described below. All four focused calibration checks also pass. See
[PR #18](https://github.com/BlinkyStitt/musical-lights-rs/pull/18) for current CI
and preview status. The PR remains draft pending physical-phone acceptance.

This supersedes the [80 ms / ISO-band report](../gain-stroke-results/README.md).
Physical iPhone acceptance remains pending; Mac WebKit does not satisfy that gate.

## Measurement and mapping

The browser now uses Moore–Glasberg–Baer partial loudness assigned to disjoint
source-frequency slices, with Glasberg–Moore short-term integration. The model
uses the selected calibrated channel, one causal periodic Hann window of 2,048
samples at 48 kHz, a 96-sample hop, free-field monaural weighting, and 0.25-ERB
filter spacing. The complete mixture sets the filter shapes; the other slices
and 15.5–20 kHz residual spectrum mask each target. Partial values do not sum to
ISO total loudness. ISO total, all 240 specific values, and terminal/hardware
behavior remain unchanged. No display sharpening or suppressive thresholds
were added. One shared adaptive gain and common headroom scale preserve ratios.

The [model report](model.json) compares the unmodified C++ oracle at
[`82de790f79c5b358040861e8bdb906a55009b117`](https://github.com/deeuu/loudness/tree/82de790f79c5b358040861e8bdb906a55009b117)
against the Rust implementation on identical spectral inputs. Maximum absolute
specific-partial error is 1.29e-14 sones/ERB; short-term error is 3.56e-15 sones.
It also compares independent NumPy FFT/PCM analysis, equal-loudness tones,
broadband, weak targets beside stronger maskers, separated tones, bursts, and
silence. The masking example leaves 0.51092% of the target's unmasked loudness,
matching the oracle. Callback sizes 1/96/128/240/4096 produce identical frames.

All 24 settled center tones exceed 90% in the intended source band. Every tested
boundary has each nonadjacent bar below 10% of the peak. Upward/downward 24-second
sweeps pass that nonadjacent criterion against the fixed causal window center;
no delay is fitted. [Production WASM checks](worklet.json) repeat the center,
boundary, and sweep checks after mapping. Ratio error stays below 2e-7. The
before/after production traces have bit-identical ISO fields for stationary,
two-tone, burst, silence, and exercise inputs.

## Default input and quieter ball rebounds

The `/phone/` route previously checked generated audio automatically while the
main status still said “Listening · Mic on.” That started a repeating test
exercise without requesting the microphone, causing activity unrelated to room
audio. Both routes now default to microphone input. Test tones require explicit
selection, and their status says “Test audio · Mic off.” The status reads the
active session source, so changing the next-start setting cannot relabel an
existing capture. Browser regressions reproduce the old source mismatch and
check silent microphone input, a real input signal, and return to silence.

Default restitution is now 0.15 instead of 0.55: ideal stationary-surface rebound
height falls from 30.25% to 2.25% of the drop height. A native regression requires
a 50 cm drop to rebound less than 2.5 cm and settle on quiet bars. The
[measured rebound](quiet-input/rebound.json) falls from 15.10 cm to 1.11 cm. Stroke timing,
contact-only launches, gravity, CCD, containment, and the solver remain intact.
The earlier timing comparisons below used restitution 0.55; new-default timing
is recorded separately in [quiet-input/browser-timing.json](quiet-input/browser-timing.json).
All six new-default host runs pass at 60.00–60.08 FPS, with p95 frame time
16.7–17 ms, no frames over 25 ms, and sampled physics debt below 8.31 ms.
Portrait fullscreen still reaches the substep cap frequently; physical-phone
acceptance remains pending.

## Session and recording repairs

Every audio start receives a new identifier and initializes fresh diagnostics
and source metadata, including microphone starts. Worklet packets carry the
identifier; both the display consumer and recording reject stale sessions.
Natural end, pause, resume, repeat changes, context interruption, and cleanup
publish playback state. Ended callbacks from replaced buffer sources are ignored.

Phone acceptance requires the actively playing, repeating 24-tone exercise with
diagnostics off. Any workload change invalidates both warmup and measurement
immediately. Resume preserves invalid reasons. Exercise PCM is normalized to
unit peak before applying the selected amplitude; all permitted levels preserve
the changing pattern and reach the advertised Float32 peak without clipping.
The regressions reproduced the reviewed implementation's failures before repair.

Normal transport remains one acknowledged 122-f64 snapshot. Optional v2 traces
have 438 f64 values per row and distinguish the ISO timestamp and measurements,
partial window-end timestamp, instantaneous and short-term partial bands, gain,
and targets. Trace packets remain bounded at 64 rows, recordings at 50,000 rows,
and physics samples at 25,000; drops remain visible.

## Motion and latency

Normal strokes and their configuration minimum are 0.040 seconds in either
direction. Reduced Motion remains 0.320 seconds. The controller preserves
velocity, brakes on reversal, and derives `v=2H/T`, `a=4H/T²`. Actual colliders,
contact-only launches, sphere CCD, eight solver iterations, open-top containment,
retained simulation time, and the 128-substep cap are retained.

[Production stroke traces](strokes.json) cover four world heights and all 24
balls. Rest-to-rest strokes arrive within 1% in **41.67 ms**, within the 50 ms
requirement at 120 Hz. The sampled near-peak reversal arrives in **50 ms**;
direction changes after 16.67–25 ms depending on contact subdivision. The
1.2/2 m full-stroke cases reach the substep cap and report it. Twenty native
physics tests pass, including single-ball and six-ball stack contact, repeated
24-ball strokes, reversals, containment, persistent overlap, and identical
30/60/120 FPS replay. Browser checks compare rendered geometry with interpolated
collider snapshots, including under Reduced Motion.

For a 1 kHz step at 0.02 peak PCM, measured from the input onset:

| Response boundary | 10% | 50% | 90% |
| --- | ---: | ---: | ---: |
| Hann-window energy | 14 ms | 22 ms | 30 ms |
| Instantaneous partial loudness | 4 ms | 10 ms | 18 ms |
| Short-term partial loudness | 10 ms | 26 ms | 48 ms |

These are nonlinear, signal-dependent response measurements, not additive fixed
latencies. The window spans 42.67 ms and its center is 21.33 ms behind its end.
Worklet delivery, physics receipt, travel, snapshot interpolation, and rendering
remain separate. The physics arrival requirement starts at physics receipt.

## Validation and reproduction

Run from the repository root with `.tools/bin` on PATH:

```sh
python3 validation/validate.py core worklet physics leptos reference
python3 validation/validate.py browser
node validation/partial/worklet.mjs
node validation/stroke-report.mjs docs/partial-loudness-results/strokes.json
node validation/phone-timing.mjs http://127.0.0.1:8104 docs/partial-loudness-results
```

The `reference` target now includes the pinned independent partial-loudness oracle
and retains every ISO/MoSQiTo check. The oracle requires `clang++`; its upstream
sources are fetched unchanged into `.cache/partial-oracle`. The production WASM
comparison uses `.cache/iso-display-before-partial.wasm`, captured from `bead4aa`
before integration. The browser suite and timing tool retain the serial startup
guard and require macOS host access. The adapted model's GPL-3.0-or-later notice,
license, and corresponding-source location are distributed with the worklet.

## Host performance

All six diagnostics-off runs pass the host timing gates: at least 59 FPS, p95
frame time at most 18.5 ms, fewer than 1% of frames above 25 ms, bounded physics
debt and snapshot age, no discarded simulation time, and less than three ticks
of simulation drift. These are 30-second Mac measurements after five seconds
of warmup, not physical-phone acceptance.

| Browser / layout | Before → after FPS | After p95 frame | Before → after physics CPU/tick | Before → after capped ticks |
| --- | ---: | ---: | ---: | ---: |
| chromium-mac / normal | 60.00 → 60.00 | 16.7 ms | 1.68 → 2.38 ms | 0 → 68 |
| chromium-mac / portrait-fullscreen | 59.90 → 60.00 | 16.7 ms | 3.34 → 3.89 ms | 1570 → 3567 |
| chromium-mac / landscape-fullscreen | 60.00 → 60.00 | 16.7 ms | 1.12 → 1.55 ms | 0 → 0 |
| iphone-profile-webkit-mac / normal | 60.00 → 60.00 | 18.0 ms | 2.23 → 2.97 ms | 0 → 50 |
| iphone-profile-webkit-mac / portrait-fullscreen | 60.00 → 60.00 | 18.0 ms | 3.88 → 4.14 ms | 1277 → 3511 |
| iphone-profile-webkit-mac / landscape-fullscreen | 60.00 → 60.00 | 18.0 ms | 1.64 → 2.27 ms | 0 → 0 |

No measured frame exceeded 25 ms. Maximum sampled physics debt was below
8.31 ms in every layout. Portrait fullscreen frequently reaches the 128-substep
cap, especially with 40 ms strokes. This remains a material physical-phone
acceptance concern; the limit is visible and simulation time is retained.

The [baseline](baseline/browser-timing.json) uses the archived 80 ms physics
and ISO display with the **same corrected, peak-normalized exercise PCM** as
the [new display](browser-timing.json). Both have diagnostics off. The initial
IPv4 asset server later hit host socket-allocation failures (`EADDRNOTAVAIL`),
so the new measurements serve identical built assets in-process via Playwright.
AudioWorklet script loading uses the exact built script through a Blob URL
because worklet module fetches bypass request routing. Audio, analysis, physics,
and rendering all execute in their real browser threads. Measurement starts
after warmup; this does not measure network/asset startup latency. No host
network settings were changed. Use `https://musical-lights.test` as the URL
argument to reproduce the in-process timing origin.

Pinned core (41 tests × four feature configurations and the Clippy matrix),
worklet, physics (20 tests), Leptos, ISO/MoSQiTo, and partial-reference validation
pass. The full browser suite passes **158 checks**, plus three startup-harness
regressions and the exercise-PCM regression. A repeat during concurrent offline
validation hit three Chromium page-load timeouts; the unchanged full suite
then passed in isolation with the standard three workers and startup guard.

The first Linux CI run subsequently failed six functional browser checks. Its
fixtures assumed that a frozen browser audio clock was newer than an
end-exclusive partial frame, that 500 ms always yielded more than 20 recorded
inputs, and that a six-second buffer always finished within ten wall-clock
seconds. Those fixtures now use monotonic packet clocks, observed input pulses,
and accelerated playback to reach the browser's actual buffer-end callback.
Calibration uses the capture context's clock rather than bridging two
independent realtime contexts, and verifies that application cleanup closes it.
The fixture leaves that context suspended until the application connects the
complete worklet graph; resuming it inside fake microphone acquisition caused
the two remaining startup failures. All four focused calibration checks pass
with the corrected ordering.
A local repeat also recorded a 256-sample callback gap: capture correctly
stopped. Functional browser tests now run with one worker so concurrent live
audio and offline stress tests do not contend. The startup guard, zero retries,
model tolerances, motion limits, and dedicated performance gates are unchanged.

A second Linux run passed 151 of 152 checks but stopped capture with a
128-sample clock gap after tone pause/resume. Pausing now keeps the source
connected: zero playback rate holds its position, and a shared playback gain
mutes the held sample for both analysis and audible monitoring. Resume restores
the same source. Natural completion is disconnected only on restart or cleanup;
a generation token rejects ended callbacks from earlier playback states.
The clock-gap check remains unchanged. Regressions measure silence and restored
loudness across six pause/resume cycles and cover restart after natural end.
The repaired Leptos build and all 158 Mac Chromium/WebKit checks pass.

## Analysis cost and end-to-end onset

The [production WASM comparison](worklet.json) processes four seconds of the
normalized exercise in 46.8 ms with ISO alone and 878.8 ms with both models
(about 22% of one realtime CPU budget on this Mac). Stationary/two-tone inputs
cost 618–671 ms per four seconds; silence costs 193 ms per three seconds.
These are offline elapsed-time samples, not AudioWorklet deadline guarantees.
The independent model is materially more expensive. All 9,500 compared ISO
frames remain bit-identical, and mapped partial-band ratio error stays below
1.55e-7.

The separate [instrumented burst runs](latency.json) capture real normal packets
and rendered collider positions with diagnostics off. Each range covers five
1 kHz burst onsets. The measurement threshold is 10% of that burst's measured
peak; the collider/render threshold is 1% of usable full-height travel. These
are different thresholds, so their differences are not additive stage delays.

| Browser | Before → after measurement onset | Before → after observed collider/render onset | Before → after p95 packet age |
| --- | ---: | ---: | ---: |
| Chromium | 24–28 → 34–36 ms | 66.7–82.7 → 72–88 ms | 5.33 → 4.00 ms |
| WebKit | 52–54 → 64–66 ms | 93.3–112 → 109.3–128 ms | 2.67 → 1.33 ms |

The new perceptual measurement responds later for this burst even though a
stable full-height physical stroke is faster. Browser audio clocks are
quantized: WebKit occasionally reports packet age down to -2 ms for the new
end-exclusive timestamp. This is clock resolution, not negative transport
latency. Rendering samples observe the same collider position in each frame;
the separate fixed-target physics test establishes the 41.67 ms travel result.
Window response, temporal integration, packet age, and physical travel must
therefore remain separately reported. The raw instrumented samples are in
`latency-detail.json.gz`. Reproduce with
`node validation/partial/latency.mjs https://musical-lights.test` after preparing
the archived baseline WASM used by the comparison tools.
