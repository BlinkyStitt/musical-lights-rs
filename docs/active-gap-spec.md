# Active gap acceptance contract

This revision supersedes the former mandatory physical-phone procedure and human
smooth-motion confirmation. Historical captures and failures remain evidence of
their stated environments. No physical operation, human listening or owner
product-use sign-off is a completion gate. Existing diagnostic UI is unchanged.

## Geometry and behavior

For the core-calculated packed opening `P`, enclosure height `H ≥ P` and reference
cap `C`, use `A = min(H, max(C, P))`. Add equal permanent bases `(H - A) / 2`,
with the existing 3 mm idle inset at each end. Retain the core's ball and flight
clearance policies. The default 60 cm cap denotes enclosure height, not stroke.
Above `max(C, P)`, settled travel stays constant as enclosure height increases;
below it, preserve the original geometry. Packing takes precedence without
shrinking or removing selected balls.

Core calculations remain reusable, bounded, allocation-free where required and
compatible with the `no_std`/`libm` feature matrix. Rapier, browser and Three.js
remain adapters. All nine banks, colliders, snapshots and depth use the same
applied endpoints. Construction fits all balls. Live cap/viewport changes retain
continuing identities, colors and normalized musical trajectories. Moving bases
use bounded contacts and occupied clearance; transitions never reset balls,
tunnel, discard elapsed time, suppress warnings or change integration limits.

Keep raw loudness, filtered targets, display gain, accessible meters and attack
eligibility independent of bases. Preserve rise duration, Reduced Motion, source
colors, contacts and flight allowance. Identical PCM/settings retain identical
analysis. Do not redesign audio, rendering, diagnostics or notifications.

The shared Home/Advanced Display slider remains **Active gap cap (cm)**, default
60, range 40–2,000, step 1. Help explains that ball/flight clearance reduce actual
travel. Preserve editor, increment/decrement, keyboard/touch help, visible focus
and 44-pixel targets. Apply live without acquiring audio. Preserve shared
fullscreen Settings, fixed scene dimensions and keyboard-open collider stability.
Persist across reload/navigation; Reset display restores 60. Invalid or missing
caps independently fall back without losing valid preferences.

Worker recordings retain initial cap and applied edits in FIFO order, including
same-tick edits during playback/resizing. Replay must match final snapshots,
geometry and pigments at 30/60/120 render rates. Reject incompatible formats or
layouts explicitly. Do not change versions without a semantic/layout change.

## Automated evidence

| Contract | Command / expected result |
| --- | --- |
| Feature matrix, native behavior, builds and produced WASM | Root `PATH="$PWD/.tools/bin:$PATH" just validate`: all checks pass, including the offline harness and benchmark correctness smoke cases; missing tools fail. |
| Packing and live transitions | Native `capped_gap_reserves_variable_ball_packing_on_construction_and_live_edits` through `just validate`: counts 0/1/8/16 remain contained; 40 cm cap with sixteen 19.2 cm balls reserves the packing floor and preserves continuing identities. |
| Controls, geometry, analysis and replay | Existing active-gap/Advanced, fullscreen Settings, mobile layout, worklet, protocol, worker and presentation tests pass in the full browser/CPU contracts. |
| Complete browser coverage | CI `python3 validation/validate.py browser`: complete unique scheduled inventory passes; preserve serial startup/crash guard, one worker and zero retries. |
| Long-run performance | Hardware CI `just validate-gpu --shard=1/2` and `--shard=2/2`: all three `active-gap-performance.spec.mjs` views pass the predicates below and recordings replay exactly. Reject software fallback. |
| Cost, transition and packet latency | GPU runner `just validate-active-gap`: verified build origin, serial collectors, cost acceptance and existing `--expect-clean` transition assertions pass. Latency reports first corresponding 10% active-travel crossings after subtracting interpolated bases; missed/already-visible/capture-ended responses stay separate. No invented latency budget. |
| Statistical CPU comparison | When physics/build/workload inputs change, idle-host `cargo +nightly-2026-09-10 bench --locked --manifest-path validation/benchmarks/Cargo.toml --bench production -- production_physics`: 20 samples, one-second warmup, at least three seconds of measurement, zero benchmark overloads. Run separately from browser checks; reuse only applicable provenance-bound evidence. |
| Integrated lighting comparison | `just validate-tilt`: hardware shading ≥59 FPS, p95 ≤18.5 ms; reject shading slowdown >10% in both orders. The software-floor policy conflict below remains unresolved. |

Compare explicit 60 cm and 2,000 cm caps in the same production engine. The
latter reproduces uncapped geometry over supported heights. Keep PCM, settings,
palette, ball configuration, seed, rise duration and fixed ticks identical.
Tall portrait full-band attacks must request fewer substeps with the cap, have
zero capped overloads, preserve normalized timing within `1e-6` and reach the
same configured deadline. Record executed/requested work, overloads and CPU cost.
Generated-audio transitions and fullscreen entry/exit additionally report debt,
snapshot age and frame timing; instrumented packet latency is separate.

For normal, portrait-expanded/fullscreen and landscape-expanded/fullscreen
views, use mobile viewports (390×844 and 844×390), repeating production generated
PCM → AudioWorklet → loudness WASM, diagnostics off, 15-second warmup and a
five-minute measurement **per view**. Count actual rendered submissions.

- Average rendered FPS ≥59, p95 interval ≤18.5 ms, fewer than 1% of intervals
  above 25 ms, at least 299,000 ms of recorded intervals.
- For `s = 1000/120 ms`, final debt `<2s`, maximum debt `<100 ms`, mean debt
  growth between first/last ten progress samples `≤s`.
- Simulation lag `≥−s` and `<3s`, absolute displayed-tick progress drift `<3s`,
  maximum snapshot age `<100 ms`.
- Zero discarded time, overflow, invalidation reasons and page errors. Missing
  samples, early termination, hidden pages, context loss, interrupted/changed
  audio and changed measured view/camera invalidate capture.

Retain transition limits unchanged, including maximum debt `<2s` and snapshot
age `<100 ms`. Hardware/browser evidence establishes its measured environment;
it does not establish physical-iPhone performance. That limit creates no manual
acceptance item. Keep failed historical frame-budget captures as failures.

## Preservation and delivery

Preserve published integration `3e93d8cd52039ed751e5a0a1b2686cc496ea53fc` and
remote descendants; inspect PR #95 and retained evidence before reuse. Bind
reports to source/build inputs, trusted producer identity, instrumentation and
file digests. The retained 202-harness/920-browser checkpoint is historical,
not current-head CI. Never rewrite retained evidence to make it match a new tree.

The orchestrator owns publication, PR evidence, exact-head CI/review and merge.
Pending CI requires waiting; failures remain failures. Preserve complete unique
coverage, artifact provenance/digest checks, serialized Pages publication and
latest-main checks. After merge, safely update local main and automatically
verify successful deployment, matching build identity, `/`, `/advanced`, normal
not-found behavior for `/phone`, cap restore/reset and live edits without audio
acquisition. A queued job or accepted notification proves no deployment.

## Unresolved requirement decision

The supplied approved criterion requires a 7 FPS software floor, while the
protected human-published integration deliberately removes it and accepts matched
5 FPS runs. Both cannot be preserved simultaneously. Its relative-only gate and
regression test remain intact pending the requested policy decision; the rest
of this revision proceeds independently. This is a requirement-authority conflict,
not a request for manual performance validation.
