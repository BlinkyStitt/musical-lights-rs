# Active gap acceptance contract

This revision supersedes the former mandatory physical-phone procedure and human
smooth-motion confirmation. Historical captures and failures remain evidence of
their stated environments. No physical operation, human listening or owner
product-use sign-off is a completion gate. Existing diagnostic UI is unchanged.

## Geometry and behavior

The half-gap adjustment splits the difference between the permanent-base and
full-opening views. For the core-calculated packed opening `P`, enclosure height `H ≥ P` and reference cap
`C`, use `A = min(H, max(C, P))` to calculate travel and flight. Keep the resting
baseline at `3 mm + (H − A) / 4` at each end. Half the extra enclosure height
remains open space and half becomes permanent bar base. The resting opening is
the arithmetic midpoint of the two earlier views. Above `max(C, P)`, settled
musical travel stays constant as enclosure height increases. Preserve ball packing, flight clearance,
normalized musical trajectories, pigments and the loudness model.

The shared Home/Advanced **Bar travel cap (cm)** control retains its saved value,
default 60, range 40–2,000 and step 1. It specifies a reference enclosure height,
not a literal stroke distance. Help explains the travel and clearance relationship.
Edits apply live without acquiring audio. Preserve keyboard/touch editing, help,
fullscreen Settings, fixed scene dimensions and keyboard-open collider stability.
Reset display restores 60. Invalid or missing values independently fall back.
All nine banks and their colliders use the same applied bar endpoints.

The browser sends the actual inward left/right camera-frustum planes as held
physics inputs. They replace the center box's side walls and follow viewport,
zoom, camera position and rotation. Kinematic walls blend signed plane coefficients through the same fixed
substeps as bars, then normalize the whole plane. This preserves shared free
space; rotating closest-point rigid frames can cut through it. Reject near-antipodal
normal changes, where the normalized blend is not bounded. The signed-clearance
derivative contributes to the existing contact-work estimate only for reachable
walls. The top/bottom surfaces and selected physical depth remain authoritative.
A bounded pool covers all nine rendered banks and their scrolling seams. Disable
posts outside the conservative ball reach and reactivate them before contact in
any visible bank. Keep rendering, contacts and source pigments aligned.
Protocol 27 and phone report v14 identify the half-gap geometry and retain both
side planes in every recorded input. Reject older recordings with the
matching-engine error.

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
| Integrated lighting comparison | `just validate-tilt`: hardware shading ≥59 FPS, p95 ≤18.5 ms; matched same-run software baseline with no absolute software FPS floor. Reject shading slowdown >10% in both orders on either renderer. Retain regressions accepting matched software 5/8/25 FPS and rejecting repeatable 20% slowdowns. |

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

The later approved fullscreen recovery policy below supersedes the original
transition maximum-debt limit. Snapshot age remains `<100 ms`. Hardware/browser evidence establishes its measured environment;
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

## Approved software comparison policy

The revised approval preserves the published integration's relative-only software
gate. It supersedes the former 7 FPS floor and resolves the previously recorded
policy question. Hardware retains its absolute frame limits; both renderers
retain the repeatable slowdown rejection. No further requirement decision is pending.

## Software fullscreen timing policy (2026-11-01)

Bryan accepts software rendering at approximately 20 FPS for now. Software FPS,
p95 frame interval and the fraction of frames over 25 ms remain reported, but do
not block fullscreen transition acceptance. This is an approximate level, not a
new minimum. Hardware keeps the existing 59 FPS, 18.5 ms p95 and <1% over 25 ms
limits. Both paths retain the existing audio, error, discarded-time, simulation
debt and snapshot-age checks. One worker and zero retries remain unchanged.

Linux WebKit can report a masked `Apple GPU` string while using llvmpipe. The
collector records native software-renderer thread evidence and classifies the
capture from that evidence. A masked Linux WebKit renderer without such evidence
is unverified and cannot pass acceptance. Hardware-requested Chromium must still
use verified hardware. This policy does not change the hardware five-minute
workload or the integrated lighting comparison's relative software checks.


## Fullscreen transition recovery policy (2026-11-02)

Bryan accepts a brief slowdown while fullscreen entry, exit or orientation changes
resize the scene, provided motion recovers. This supersedes the requirement to
meet steady-state frame and debt limits during the transition itself.

Measure from the input mark, without waiting for a favorable frame: allow at most
1,000 ms for the transition, then require a complete 2,000 ms recovery window.
Hardware must recover to at least 59 FPS, p95 intervals at most 18.5 ms and fewer
than 1% of intervals over 25 ms. Bryan accepts the normal steady-state catch-up
contract for both renderers: maximum debt below 100 ms, final debt below
`2 * 1000/120 ms`, and mean debt growth between the first and last ten recovery
samples at most `1000/120 ms`. This replaces the every-sample 16.67 ms recovery
debt limit; isolated peaks can pass only if the scene catches up. Snapshot age
stays below 100 ms. Software FPS remains reported without an absolute floor.
The five-minute and tilt gates do not change.

Count actual submitted frames with the existing renderer report hook; animation
callbacks with skipped draws do not establish recovery. Keep the complete
three-second transition capture and all worker/process timings.
During the whole capture, debt and snapshot age must stay below 100 ms. Reject
any hardware frame interval of 100 ms or more and any software interval of
1,000 ms or more. These bounds prevent accepting a freeze during the allowance.
Include the first frame across the end boundary, so a late freeze cannot vanish
from the capture. Missing coverage, audio failure, page errors and discarded
simulation time still fail. Keep one worker, zero retries and failed exports.

This is a changed acceptance policy, not an application speedup. Earlier strict
transition failures remain historical failures. Existing two-second captures do
not prove the new full two-second recovery hold after its one-second deadline.


## Temporary 30 FPS hardware acceptance (2026-11-02)

Bryan approved a temporary 30 FPS requirement if frame timing still blocks delivery.
The corrected wall sweep removed the measured contact overloads, but a local stock
WebKit capture near 60 FPS still failed the former 18.5 ms p95 limit at 19 ms.
Use the shared hardware frame budget: FPS at least 30, p95 intervals at most 37 ms,
and fewer than 1% of submitted intervals over 50 ms. The interval allowances scale
the former 60 Hz budget to 30 Hz. These values supersede the earlier absolute
59 FPS / 18.5 ms / 25 ms values for long captures, fullscreen recovery and hardware
lighting comparisons. Rendering continues at the available cadence; this is a test
acceptance policy, not a renderer cap. Software FPS remains non-blocking.

Keep every debt, snapshot-age, recovery-duration, discarded-time, audio, provenance,
coverage and zero-retry requirement unchanged. Keep the relative lighting slowdown
gate. Report v12 uses `slowFrameFraction` with its explicit 50 ms threshold. Retain
all older failed captures with their original verdicts; acceptance under this new
policy does not prove the former 60 FPS workload passes.
