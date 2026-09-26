# Accurate loudness, calmer motion, and contained balls

This revision of [PR #18](https://github.com/BlinkyStitt/musical-lights-rs/pull/18)
removes frequency emphasis, stabilizes browser motion, replaces renewable white
holds with prominent-attack pulses, and closes the physical enclosure.
Physical iPhone acceptance remains pending. Mac WebKit is not physical-phone proof.

## Measurement accuracy

The MGB1997 partial-loudness equations, GM2002 short-term integration, calibration,
selected channel, and ISO measurements are unchanged. The browser still uses a
causal 2048-sample periodic Hann FFT at 48 kHz, advancing every 96 samples, with
free-field monaural weighting and 0.25-ERB auditory filters. Assigning partial
loudness to 24 disjoint frequency slices is this application's representation;
the partial values do not sum to ISO total loudness. The fixed FFT front end is
an application adaptation, not a claim of complete published-model conformance.

The [independent oracle](model.json) remains pinned to
[`82de790f79c5b358040861e8bdb906a55009b117`](https://github.com/deeuu/loudness/tree/82de790f79c5b358040861e8bdb906a55009b117).
It checks identical spectral inputs, independent NumPy PCM analysis, masking,
equal-loudness tones, broadband sound, bursts, silence, and callback partitioning.
No acceptance thresholds have been relaxed. ISO/MoSQiTo comparisons also pass.

[Production before/after traces](contained-display/presentation.json) confirm
bit-identical ISO and raw partial measurements against `76af307` for stationary,
two-tone, burst, exercise, and silence inputs. The former 2x treble shelf is
removed; bass is not boosted. Shared gain and headroom limiting preserve measured
ratios to within 2e-7. [Selectivity checks](worklet.json) cover all 24 centers,
boundaries, and both sweep directions before and after presentation filtering.
A scalar SPL calibration does not establish the microphone's frequency response.

## Browser presentation

The [One Euro filter](https://gery.casiez.net/1euro/) uses minimum and derivative
cutoffs of 1 Hz and beta 0.8. One coefficient, determined by the largest absolute
filtered derivative, applies to every source band on the 2 ms audio clock.
Rising and falling responses are symmetric; settled values and proportional
input histories are preserved. Filtering changes motion, not measured sones.
The native regression requires a half-height step to reach 90% within 32 ms and
at least 60% attenuation of simultaneous, out-of-phase 8 Hz ±10% fluctuations.
The production implementation is compared against independent scalar equations.

[SuperFlux](https://phenicx.upf.edu/system/files/publications/Boeck_DAFx-13.pdf)
novelty reuses the same FFT. Source attribution, loudness eligibility, rearming,
and pulses are presentation choices. Spectral candidates can wait up to 30 ms
for the same attack's integrated loudness to qualify; a measured loudness rise
rejects spectral leakage at tone offsets. Tests cover sustained tones, vibrato,
tremolo, gentle swells, repeated attacks, masked weak targets, silence, startup,
and gain-only changes. This is prominent-attack detection, not note recognition.

White is confined to a one-pixel inner border with a 100 ms quadratic fade.
It reaches exactly zero, has no renewable hold, and does not whiten the fill.
Reduced Motion halves pulse intensity. Terminal and hardware behavior is unchanged.
See [the complete numerical and transport contract](../loudness.md).

## Closed enclosure and restrained hops

A real ceiling collider matches the visible boundary. Upper clearance reserves
the largest sphere diameter, a hop allowance, and 4 mm. The minimum enclosure is
0.40 m; initial placement fits without overlap. Shrinking waits for vacant
clearance, preserving positions and velocities, while the camera fits the whole
transitional enclosure and keeps guides and hit regions aligned.

Only excess upward velocity on separation from a bar-driven support chain is
dissipated, limiting additional free-flight hops to `min(0.08*height, 0.05)` m,
halved for Reduced Motion. Stacks propagate support. Carrying, ordinary drops,
lateral/angular motion, and external forces remain intact. This launch limit is
an animation choice, not a material measurement. Restitution remains 0.15.

Near the ceiling, contact stiffness and positional stabilization increase to
prevent compression through the roof. Ordinary collisions retain their prior
response. Eight force-solver iterations, sphere CCD, the 128-contact-substep cap,
and retained simulation time remain. [Physics details](../physics.md) distinguish
force iterations from the additional positional stabilization passes.

[Production stroke traces](contained-display/strokes.json) retain 41.67 ms
rest-to-rest arrival, within the 50 ms requirement. Reversal is separate:
25 ms to change direction and 58.33 ms to arrive. Normal stroke/minimum remains
40 ms in both directions; Reduced Motion remains 320 ms.

## Timing and validation

For the 0.2-peak 1 kHz burst in [presentation.json](contained-display/presentation.json),
input-onset to 10%/50%/90% response is 10/24/38 ms for instantaneous partial
loudness and 18/40/76 ms for short-term loudness. Mapped targets reach those
fractions in 8/14/18 ms and filtered targets in 16/22/34 ms; mapping saturation
explains why display fractions arrive earlier than loudness fractions. The
white attack is accepted at 12 ms. These are signal-dependent boundaries, not
additive delays. The window spans 42.67 ms; transport, physics, and rendering
are measured separately.

The diagnostics-off WASM comparison adds 1.1–2.9% CPU time over `76af307` across
the five fixtures. The repeating exercise takes 894.4 ms to process 4 seconds
of PCM (22.36% of one host core), versus 876.0 ms before this change. These
offline measurements do not establish a phone's real-time processing budget.

All 48 core tests pass in four feature configurations, with the Clippy matrix,
all 26 native physics tests, worklet and Leptos checks/builds, pinned references,
and all 159 Chromium/WebKit checks (one worker, zero retries). Replay remains
identical at 30/60/120 render FPS. Full-height compression covers heights
0.40, 0.415, 0.60, and 1.20 m, immediately and after three settling intervals;
every sphere stays within the unchanged 5 mm ceiling tolerance.

All six [diagnostics-off runs](contained-display/browser-timing.json) pass the
existing FPS, frame-time, debt, snapshot-age, and simulation-progress gates.
Each uses the active repeating exercise, five seconds of warmup, and thirty
seconds of measurement. No measured frame exceeds 25 ms, and no simulation time
is discarded. Physics cost is compared with the previous `76af307` host results;
these are separate runs, not controlled phone measurements.

| Browser / layout | FPS | p95 frame ms | Max sampled debt ms | Physics ms/tick, previous → current | Capped ticks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium / normal | 60.00 | 16.7 | 8.27 | 2.37 → 1.27 | 0 |
| Chromium / portrait-fullscreen | 60.00 | 16.8 | 8.27 | 4.83 → 2.95 | 14 |
| Chromium / landscape-fullscreen | 60.00 | 16.7 | 8.23 | 1.38 → 0.84 | 0 |
| WebKit, iPhone profile / normal | 60.92 | 18.0 | 8.00 | 2.24 → 1.41 | 0 |
| WebKit, iPhone profile / portrait-fullscreen | 60.10 | 18.0 | 8.00 | 5.25 → 3.37 | 16 |
| WebKit, iPhone profile / landscape-fullscreen | 60.11 | 18.0 | 8.00 | 1.70 → 0.93 | 0 |

Portrait fullscreen reaches the 128-substep cap on 14/16 ticks in Chromium/WebKit;
the excess demand remains visible in the report. It does not accumulate debt or
discard time. Other layouts have no capped ticks in these runs.

The separate [instrumented 25 ms burst run](contained-display/latency.json)
observes 1% bar/render height at 93.3–98.7 ms in Chromium and 112.0–130.7 ms in
WebKit from the source's scheduled onset. Historical partial-display results
were 72–88 ms and 109.3–128 ms respectively; calmer filtering adds response time.
The measured partial-loudness crossings are unchanged at 34–36 ms / 64–66 ms
on these browser paths. This browser/source-clock measurement is distinct from
the direct-PCM step above and the 41.67 ms physics-receipt stroke. Sampled
transport age p95 is 4.0 / 1.33 ms. Chromium's -2.67 ms minimum is one audio
quantum; this clock comparison cannot establish physical transport latency at
that resolution. Collider and render readings
are sampled once per animation frame, so coincident crossings do not imply zero
render latency. Raw packet and frame timestamps are retained in the compressed
artifact.

Failed model, containment, or performance checks block promotion. Physical-phone
acceptance and the existing production deployment gate remain in force.

Run from the repository root with `.tools/bin` on PATH:

```sh
python3 validation/validate.py core worklet physics leptos reference
python3 validation/validate.py browser
node validation/partial/worklet.mjs
node validation/partial/presentation.mjs .cache/before-contained.wasm
node validation/stroke-report.mjs docs/partial-loudness-results/contained-display/strokes.json
node validation/phone-timing.mjs https://musical-lights.test docs/partial-loudness-results/contained-display
node validation/partial/latency.mjs https://musical-lights.test
```

Browser commands require macOS host access and retain the serial startup guard,
one worker, and zero retries. The presentation baseline is the production WASM
from `76af307`. Historical [responsive-display](responsive-display/browser-timing.json),
[quiet-input](quiet-input/browser-timing.json), and [80 ms/ISO](baseline/browser-timing.json)
measurements remain available. They do not validate this revision.
