> Historical 80 ms / ISO-band display report. Current behavior and measurements are in [the 40 ms source-band report](../partial-loudness-results/README.md).

# Proportional loudness and fast strokes

Baseline: `2e6672e0199fcf908202418a00bc7f56aaf3005f` (PR #17).
Measurements below were collected on macOS on 2026-09-21/22. Physical iPhone
measurements are still pending because the device is unavailable. No microphone
calibration or loudness-model calculation changed.

## Controlled tones

The [comparison](comparison.json) covers 265 seconds / 132,500 model frames:
60 s stationary 1 kHz, 48 s stepping through all 24 band centers, 24 s continuous
50–13,700 Hz sweep, 30 s simultaneous 1 kHz and 3.4 kHz, 90 s volume steps,
8 s of 25 ms bursts, and 3 s silence. PCM peak amplitude is 0.02; the volume
sequence is 0.02 → 0.002 → 0.01 at 30-second boundaries. Two tones split the
amplitude equally. The phone page offers the same generators, input settings,
pause/resume, repeat, optional audible playback, and diagnostic export.

A uses fixed unity gain and the old compression. B uses the original automatic
gain and compression. C reuses **each exact B gain** and applies a common
proportional headroom scale. The actual old/new producers also run on the same
Float32 PCM; their traces include independent white-edge state. These comparisons
are diagnostics, not selectable production display modes.

| Case and timestamp | Measured adjacent/peak | A: fixed + compressed | B: adaptive + compressed | Old retained height | C and new targets |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 kHz at 59.998 s | 83.40% | 92.55% | 96.02% | 96.02% | 83.40% |
| Sweep at 23.998 s | 45.12% | 59.03% | 68.00% | 77.57% | 45.12% |
| Volume decrease, 59.998 s | 81.54% | 86.21% | 94.47% | 94.47% | 81.54% |

For the illustrative 10%-loudness neighbor at a compressed 80%-height peak,
`x_peak=4`: old neighbor height is `0.4/1.4=28.57%`, or **35.71% of the peak**.
The proportional mapping keeps it at 10% of the peak at every shared gain.
The volume-step trace retained as much as 48.43 percentage points of artificial
height above its instantaneous old mapped target; short bursts retained 66.62
points. The new targets have no retained heights.

All 240 measured values, total sones, and all 24 integrals were **bit-identical**
before and after. New normalized target errors are at most **9.63e-8**; maximum
absolute error from the current common-scale target is **8.37e-8**. C's f64
ratio error is at most 2.23e-16. These checks include adaptation, decreased
volume, frequency changes, model tails, and silence.

The pinned MoSQiTo 1.2.1 comparison checked all **31,800,000 specific values**
and every band integral, before and after. Both [before](oracle-before.json)
and [after](oracle-after.json) pass the repository's existing reference limits:
no point outside max(0.2 sone, 10%), and at least 99% inside max(0.1 sone, 5%).
All controlled-tone values were inside the tighter limit. Maximum specific
error was 0.06113 sones/Bark, maximum total error 0.01663 sone. Differences are
reported without fitting gain or shifting the frame grid. MoSQiTo's returned
`linspace` time labels include an endpoint; comparisons use its fixed 2 ms
frame indices. The independent ISO cases 6–25 and existing four MoSQiTo fixture
comparisons also pass. The broad pure-tone distributions are expected model
output; they are not forced into one band.

## Motion and timing

[Stroke traces](strokes.json) use the production WASM with all 24 balls and
world heights 0.1, 0.6, 1.2, and 2 m. Every tested up/down rest-to-rest stroke
arrives within 1% at **75 ms**, and rests by the tenth 120 Hz tick (83.33 ms).
The controller's continuous full-stroke duration is 80 ms. Reduced Motion uses
320 ms. Speed and acceleration limits remain derived from usable height.

**Accepted timing contract:** preserve the specified motion limits and report
reversal latency separately. The 100 ms arrival requirement applies to strokes
from rest, not arbitrary reversals. An opposite endpoint requested near
peak velocity arrives within 1% at **116.67 ms** from receipt; downward velocity
begins at 41.67 ms. The plan's acceleration/velocity limits and preserved velocity
cannot also guarantee arbitrary reversals within 100 ms. At exactly peak speed,
braking needs 40 ms and leaves an 80 ms full stroke in the opposite direction.
The implementation preserves these limits and velocity through retargeting;
reversal timing includes braking and is reported separately from strokes from rest.

Native tests cover single-ball contact, six stacked balls, 24-ball repeated
full-height motion, rapid reversals, equal opposing fast spheres, high side
impacts above the former wall height, and explicit substep overload. The
20-second 24-ball stress test had maximum transient wall penetration **0.701 mm**
(3.36% of radius); after allowing ballistic return, all balls had a support path
and settled within 1 mm of non-overlap. No center escaped. The top stays open.
All 19 native physics tests pass, including identical replay at 30/60/120 FPS.

[Tone physics replays](tone-physics.json) feed the old and new measured targets
at 60 Hz to their actual respective physics WASM builds. Every case retains all
24 balls, the 120 Hz clock, and source-frame indices. All balls remain contained.
At the default 0.6 m height, the new runs need at most 64 contact substeps and
record no overload. Full strokes in taller worlds reach the 128-substep limit;
`strokes.json` records those ticks rather than claiming unbounded contact work.

Latency boundaries are separate:

- Measurement: 2 ms output grid and 1 ms lookahead; frequency-dependent filter
  integration and prescribed loudness temporal response are signal-dependent.
- Transport: one outstanding worklet packet; diagnostics record model sample
  index, worklet audio time, receipt audio time, and monotonic host time.
- Physics input: recorded source timestamp and applied tick. The deterministic
  60 Hz tone replay has maximum source-frame age 18.67 ms at step completion.
- Physical travel: the 75 ms arrival above begins at physics receipt.
- Render: snapshot interpolation adds a snapshot interval; traces record render
  timestamp, interpolation fraction, worker tops, velocities, and rendered tops.
  Browser tests compare rendered geometry to the corresponding interpolated
  collider snapshots, not a newer asynchronous snapshot.

White edges use acoustic peaks only. Gain changes cannot generate an attack.
Targets retain the model's tail and reach zero only when the model reports zero.
No new smoothing or per-band suppression was added. The former test claiming a
combined bar/edge flash-rate bound relied on the removed height hold and has
been replaced with direct-target and independent-edge assertions. Static images
and Mac automation do not establish perceived phone flicker or smoothness.

## Validation and reproduction

Pinned `core worklet physics leptos` validation passes: 41 core tests in each of
four feature configurations, the Clippy matrix, 19 native physics tests, WASM
Clippy/builds, Leptos host tests and release build. Python format/lint/type checks
pass. The full browser run passes **124 checks**, plus the **three serial-startup
harness regressions**, with Chromium and WebKit on macOS. Coverage includes
all seven real AudioWorklet tone sources, bounded diagnostics, callback-size
independence, keyboard/touch accessibility, fullscreen counter, Exit, replay,
render/collider agreement, and route/audio/worker cleanup.

Run from the repository root with `.tools/bin` on PATH:

```sh
python3 validation/validate.py core worklet physics leptos reference
python3 validation/validate.py browser
node validation/tone-comparison.mjs .cache/tones-after
validation/loudness/.venv/bin/python validation/loudness/tones.py .cache/tones-after
node validation/compare-tone-results.mjs
node validation/stroke-report.mjs
```

The before run was captured before changing mapping and holds, with the same
opt-in trace instrumentation. Full binary model traces and deterministic PCM
are in `.cache/tones-before` and `.cache/tones-after`. Each model row is f64:
sample index, total sones, 240 specific values, 24 integrals, gain, display
transport (146 values before, 122 after). `*-comparison.f64` has sample index
and A/B/C/production heights. `*-physics.f64` has simulation seconds, source
model row, 24 actual tops, 24 velocities and four cost/limit fields; baseline
velocity/cost slots are zero because its ABI did not expose them. The archived
baseline physics source is unmodified except for an empty workspace boundary
in its temporary manifest. Use that matching WASM for `tone-physics.mjs`.

The [Mac browser timing report](browser-timing.json) and screenshots measure
30 seconds after 5 seconds of warmup in normal, portrait fullscreen, and
landscape fullscreen. These are host diagnostics, not the three five-minute
physical iPhone acceptance runs. Physical phone FPS, observed smoothness, and
flicker remain unverified. CI, merge, and deployed-commit verification are
reported separately in the PR.


| Mac browser / layout | FPS | p95 frame interval | Maximum sampled physics delay | Capped ticks / 30 s |
| --- | ---: | ---: | ---: | ---: |
| Chromium normal | 60.00 | 16.7 ms | 8.27 ms | 0 |
| Chromium portrait fullscreen | 60.00 | 16.7 ms | 8.30 ms | 1,733 |
| Chromium landscape fullscreen | 60.00 | 16.7 ms | 8.30 ms | 0 |
| WebKit iPhone profile, normal | 60.00 | 18 ms | 8.00 ms | 0 |
| WebKit iPhone profile, portrait fullscreen | 60.00 | 18 ms | 8.00 ms | 2,247 |
| WebKit iPhone profile, landscape fullscreen | 60.00 | 18 ms | 8.00 ms | 0 |

No measured frame interval exceeded 25 ms. Portrait fullscreen frequently reaches
the contact subdivision cap despite keeping up on this Mac; this is explicitly
visible in the UI and must be evaluated on the phone. The full interval and
progress samples are in [compressed timing data](browser-timing-detail.json.gz).
