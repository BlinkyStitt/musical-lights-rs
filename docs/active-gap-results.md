# Active gap validation

The [current specification](active-gap-spec.md) supersedes every older manual
phone, physical-access and human-confirmation gate in this historical report.
Acceptance now uses reproducible automated hardware/browser evidence with the
same numerical thresholds. Ordinary owner use creates no pending acceptance
item. Historical captures, failures and their provenance below remain unchanged;
they do not establish current-head CI or physical-iPhone performance.

## GPU recovery evidence (2026-10-31)

[Run 41193507076](https://github.com/BlinkyStitt/musical-lights-rs/actions/runs/41193507076)
tested `f9c51d5fb67c0eebdb4e542cce9e8087309af14a` on Chromium 156.0.8078.4,
ANGLE/virgl on Intel Iris Plus 655. All three five-minute captures failed:
normal/portrait/landscape averaged 53.42/52.82/54.79 FPS, with 33.3–33.4 ms
p95 intervals. Normal and portrait maximum debt was 388.07/209.87 ms; landscape
was 21.50 ms. Portrait additionally recorded 256 missing and 256 overlapping
audio samples. These remain failed captures.

The retained animation counters recorded 18,869/18,817/18,834 callbacks and
2,066/2,250/1,645 GPU backpressure rejections over the capture, including warmup.
The previous queue retained only the newest fence: a finished older submission
could not release its slot until the newer submission also finished. The repair
retains two fences and reclaims completed slots in order, preserving the limit
of two outstanding submissions and zero-time completion polls. Harness and
browser regressions exercise partial completion and a fully blocked GPU.
Native process artifacts show two available CPUs and scheduling waits, without
cgroup quota throttling or OOM events; the queue repair does not establish that
all frame/debt failures are fixed.

Muted playback also polled the output clock at 10 Hz. In the pinned Chromium,
[`getOutputTimestamp`](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/third_party/blink/renderer/modules/webaudio/audio_context.cc)
holds the graph lock, while
[`UpdateWorkletGlobalScopeOnRenderingThread`](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/third_party/blink/renderer/modules/webaudio/base_audio_context.cc)
updates `currentFrame` only if its try-lock succeeds. This is a source-supported
explanation for the observed overlap/gap, not a captured lock-contention trace.
Muted playback with diagnostics off now avoids output timestamp and latency
queries and explicitly reports `processing-clock` / `output muted`. Audible
playback and diagnostic recording retain output-clock measurements. PCM,
analysis continuity checks and acceptance invalidation remain unchanged.

`just validate` includes the queue and transport regressions. The browser suite
also checks partial GPU completion and mute/unmute clock selection against the
built app. Exact-head GPU CI must still evaluate all original five-minute,
transition and comparison thresholds; local checks do not establish their pass
or physical-phone performance.

## Earlier validation checkpoints

The [full browser checkpoint](#full-browser-checkpoint-2026-10-30) records a
successful complete suite. The [review checkpoint refresh](#review-checkpoint-refresh-2026-10-30)
records statistical and served-app measurements at its stated source checkpoint.

The candidate compares explicit 60 cm and 2,000 cm caps in the same engine.
The latter preserves the old uncapped geometry at all supported heights. This
isolates geometry while retaining identical production PCM, settings, targets,
rise duration and fixed ticks. Raw loudness and filtered targets are checked
against the production worklet oracle even across a live cap edit.

`validation/physics-cost.mjs PHYSICS_WASM OUTPUT_JSON` compares generated-audio
portrait/landscape transitions and settled full-band attacks. It reports actual
and requested substeps, overloads, CPU time, baseline and displacement above it.
`validation/fullscreen-timing.mjs ORIGIN OUTPUT_JSON` compares both caps through
enter, landscape, portrait and exit with production generated audio and diagnostics
off. It records frames, debt, snapshot age, requested and executed substep
totals, and overloads. Totals accumulate every worker tick, including between
published snapshots.
`validation/active-gap-latency.mjs ORIGIN OUTPUT_JSON` separately enables tone
traces for real worklet burst packets and rendered surface crossings. It measures
receipt to the first rendered 10% crossing, subtracting the interpolated permanent
base and dividing by active travel. A later same-band attack cannot complete a
missed earlier response. Misses, already-visible bars and capture-end cases stay
explicit; delay quantiles describe observed crossings only. Instrumentation cost
is not phone FPS evidence. These scripts
retain the serial browser guard; statistical Criterion runs must be separate.

The Criterion production workloads name capped and uncapped portrait music and
full attacks explicitly. See [benchmark instructions](../validation/benchmarks/README.md).
Large raw logs stay outside Git.

## Local measurements (2026-10-30, before the main rebase)

These measurements describe the original active-gap implementation, before
rebasing onto main `dbe3c1c1e76572a590e753b19a6a0b880d036198`. They do not
measure the combined variable-ball/HSLuv engine introduced by that rebase.

Linux x86-64 on an AMD EPYC 7643 virtual host, Rust
`1.100.0-nightly (a36d05efa 2026-09-09)` and pinned Node 26.8.2.
The statistical run used the repository's 20-sample Criterion configuration,
without another validation or browser workload running. Both geometries use
the same candidate engine; 2,000 cm reproduces full-height travel at these
enclosure sizes. These are geometry comparisons, not physical-phone results.

| Workload | 60 cm cap | 2,000 cm cap |
|---|---:|---:|
| Native portrait music, 240 ticks, time (95% CI) | 149.83–155.47 ms | 289.63–293.14 ms |
| Native portrait full attacks, 240 ticks, time (95% CI) | 73.171–74.260 ms | 169.06–170.04 ms |
| WASM 12-second PCM/resize sequence, requested substeps | 7,323 | 10,983 |
| WASM sequence CPU time, median of three runs | 1,579.85 ms | 2,036.05 ms |
| WASM tall portrait attack, 16 ticks, requested substeps | 106 | 462 |
| WASM tall attack, maximum requested substeps/tick | 19 | 106 |

All offline WASM cost runs and native benchmark workloads had zero overload ticks.
The tall attack needs 77% fewer integration substeps. The produced-WASM
regression also compares normalized musical samples through the attack and
requires the same target deadline; the exact-PCM browser oracle checks raw
loudness and filtered targets across a cap edit.

The measured physics WASM SHA-256 is
`17fd3a0fb70e0ffcf87d58595020a276c6ae93fd757361edde5bb598cf7ab19b`;
the 12-second generated PCM SHA-256 is
`d16367d07889a3ec7c5abcbdd3f7b82a1a542ba50f8a533e8b2d30b0554d9989`.
Raw logs and traces are outside Git: `/tmp/ski1240-benchmark.log`,
`/tmp/ski1240-cost.json` and `/tmp/ski1240-cost.log`.

The served candidate was measured with Chromium 154.0.8037.0 and WebKit 26.6
(iPhone profile), starting at 390 × 844 and rotating to 844 × 390. Each row
summarizes four two-second enter/landscape/portrait/exit windows, with diagnostics
off and identical generated exercise settings and seed 1. Requested and executed
substep totals were equal; there were zero overloads, discarded milliseconds or
page errors in these transition captures.

| Browser / cap | Requested substeps | FPS range | Worst p95 frame | Max debt / snapshot age | Worst fraction >25 ms |
|---|---:|---:|---:|---:|---:|
| Chromium / 60 cm | 6,309 | 32.78–40.50 | 50 ms | 8.30 / 71.70 ms | 72.06% |
| Chromium / 2,000 cm | 10,885 | 30.76–40.00 | 50 ms | 14.23 / 73.70 ms | 77.61% |
| WebKit / 60 cm | 6,159 | 23.05–42.35 | 53 ms | 7.67 / 24 ms | 100% |
| WebKit / 2,000 cm | 10,512 | 22.90–41.73 | 56 ms | 9.67 / 25 ms | 100% |

The cap reduces transition integration work on this host, but neither geometry
meets the phone frame-rate criteria. These host results do not establish a
smooth-motion fix. Raw transition frames and snapshots are retained in
`/tmp/ski1240-fullscreen.json`.

The separate instrumented burst capture measures receipt-to-render delay at 10%
of active travel. Its raw packets/renders were reanalyzed with the tested response
matcher, preserving all capture observations:

| Browser / cap | Observed / crossings | Already visible | Not observed (capture ended) | Median / p95 delay |
|---|---:|---:|---:|---:|
| Chromium / 60 cm | 79 / 87 | 0 | 8 (5) | 91.7 / 98.7 ms |
| Chromium / 2,000 cm | 76 / 80 | 0 | 4 (1) | 90.6 / 138.3 ms |
| WebKit / 60 cm | 79 / 104 | 11 | 14 (2) | 66 / 104 ms |
| WebKit / 2,000 cm | 59 / 115 | 9 | 47 (2) | 85 / 117 ms |

Brief filtered pulses can retract before the rendered surface crosses 10%; these
are unobserved responses, not delays borrowed from a later note. This capture
does not establish a packet-to-render acceptance budget or phone performance.
The instrumented uncapped Chromium run recorded one overload tick; its capped
run and both WebKit runs recorded zero. Diagnostic recording adds workload.
Use the corrected summaries in `/tmp/ski1240-latency-reanalyzed.json`; the
unchanged raw capture is `/tmp/ski1240-latency.json`. Reproduce its analysis with:

```sh
node validation/active-gap-latency.mjs --reanalyze /tmp/ski1240-latency.json /tmp/ski1240-latency-reanalyzed.json
```

## Original local correctness and remaining acceptance

The core feature matrix passed 129 tests in each of four configurations;
native physics passed all 70 tests. Worklet, physics WASM and Leptos checks
and builds, benchmark correctness workloads, and all 161 Node harness tests
passed (including two response-matcher regressions). The full browser run
finished with 634 passes, one failure and two
existing opt-in skips (live YouTube and review-preview generation). All nine
active-gap cases and the exact-PCM oracle passed across their browser projects.

The remaining failure is the iPhone-profile backward-clock recovery test:
reported output position fell from 66.89 ms to zero while session, node count
and AudioContext identity stayed unchanged. A separate instrumented run retained
the assertions and captured native `getOutputTimestamp()` pairs and failed
requests. Native performance timestamps advanced into the future relative to
`performance.now()` by up to 2.10 seconds with the cap and 3.19 seconds uncapped.
The existing output-clock extrapolation consequently returned near-zero output
time while processing advanced in both configurations. No requests failed.
The capped diagnostic reproduced the assertion; uncapped diagnostics passed
their endpoint assertions but also recorded a transient output-position decrease.
This evidence does not resolve the failed full-suite check. Playback source
and output-clock calculations are unchanged by this implementation.

Evidence: `/tmp/ski1240-browser-final.log`,
`/tmp/ski1240-original-clock-failure/`, `/tmp/ski1240-clock-evidence.log`,
`/tmp/ski1240-clock-baseline.log` and `/tmp/ski1240-clock-{60,2000}.json`.
The Dioxus CLI also reported its existing unsupported-DWARF `wasm-opt` abort
while returning success and emitting an unoptimized app; its rendered-page
check passed. Optimization success is not established.

No physical-phone measurement was collected at this checkpoint. Its older
manual acceptance demand is superseded by the automated contract above. Linux
CI and production verification remain separate from these local results.

## Rebase validation (2026-10-30)

Rebased onto main `dbe3c1c1e76572a590e753b19a6a0b880d036198`, retaining
variable balls, HSLuv pigments, camera controls and the existing validation
recipes. Protocol 22/report v8 keep the ball fields separate from the appended
cap and normalized-motion fields. Native coverage now also checks packed
variable balls under a 40 cm cap; worker coverage combines ordered ball/cap
edits during resizing and verifies exact replay.

All commands ran from the repository root with `.tools/bin` prepended to PATH:

- `python3 validation/validate.py core worklet physics leptos benchmarks dioxus wasm`
  returned 0. Each core feature configuration passed 137 unit and six PCM tests;
  native physics passed 78 tests. Clippy, produced-WASM builds, Leptos checks,
  and Criterion correctness smoke workloads completed. Dioxus again reported
  `wasm-opt failed with status code signal: 6 (SIGABRT)` with unsupported-DWARF
  output, then emitted its app and returned 0. Its optimization remains failed;
  the full browser run passed the Dioxus page and standalone WASM worklet checks.
- `python3 validation/validate.py browser` returned 1: all 202 offline harness
  tests passed; browsers finished with 919 passes, one failure and two existing
  opt-in skips. The iPhone-profile live-cap test called `normalView` before
  mobile expansion mounted. Its trace records Exit as absent, followed by
  `startFrozen` opening/closing Settings in expanded mode. The cap slider then
  remained hidden in the closed dialog and `locator.fill` timed out before any
  cap edit. The repair awaits `physicsReady` before exiting and asserts normal
  mode, retaining every meter, trajectory and geometry assertion.
- `.tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.config.mjs active-gap.spec.mjs --output .ci/ski1240-rebase/cap-tests`
  returned 0 after that repair: all nine Chromium/WebKit/iPhone-profile cap tests
  passed. Both browser commands retained serial startup, one worker and zero
  retries. The unchanged full suite was not repeated to replace its failed result.
- `node validation/physics-cost.mjs musical-lights-physics/pkg/physics_bg.wasm .ci/ski1240-rebase/cost.json`
  returned 0, separately after browser validation. With the production HSLuv
  palette, the 12-second PCM/resize sequence requested 7,369 substeps capped
  versus 10,963 uncapped. Median CPU time over three runs was 1,567.07 versus
  2,028.85 ms. The tall 16-tick attack requested 106 versus 462 substeps
  (maximum 19 versus 106 per tick); all cost runs had zero overloads. The
  produced-WASM regression also passed identical normalized attack timing.

The rebase physics WASM SHA-256 is
`2950ea64928627ea553ebf96afa130ea355e38e40c989111c03895460f7f2f83`.
The PCM digest matches the original comparison above; palette SHA-256 is
`617480648c6e590e5949ec6d9faaba4e5a873f69174882d3cd375e7bfd00bf25`.
Logs, cost JSON, original failure trace and native/request evidence are retained
outside Git under `.ci/ski1240-rebase/`.

At this rebase checkpoint, statistical Criterion, served-app frame/debt/snapshot-age
and packet-to-render measurements had not yet been refreshed. The next section
supplies that evidence. No physical-phone performance is established.

## Review checkpoint refresh (2026-10-30)

Measured clean source commit `0a66d0ddb4c0ab6a5161dd86660ac0959323ec5c`, tree
`b77b5f9d1d28aa8c9056944f9ea27aa361d53ea4`, including the variable-ball/HSLuv
rebase. This follow-up changes only this report; production code and measurement
scripts are unchanged. The rebuilt served runtime is `98404a0fc98ea85bffef1e09`;
all four transition captures reported the exact source commit above. All measured
artifact files remained byte-identical throughout collection.

The Linux x86-64 KVM host exposes eight AMD EPYC 7643 CPUs. Tools were Rust
`1.100.0-nightly (a36d05efa 2026-09-09)`, Node 26.8.2, Trunk 0.22.0-beta.5,
wasm-bindgen 0.2.128 and Playwright 1.64.1. Chromium was 156.0.8078.4;
WebKit was 27.2 with the iPhone 13 profile. These are host measurements.

### Commands and retained evidence

All validation commands ran from the repository root with pinned tools on PATH.
`just validate` returned 0: workflow lint, 42 tooling tests, four core feature
configurations (137 unit tests and six PCM tests each), 78 native physics tests,
Clippy, worklet/physics WASM and Leptos builds, benchmark correctness smoke cases,
and 202 offline harness tests passed. The recipe also built Dioxus and standalone
WASM. Dioxus again logged `wasm-opt failed with status code signal: 6 (SIGABRT)`
before returning 0 and emitting its app; successful Dioxus optimization is not
established. The full browser suite was not repeated for this report-only change;
the previous suite outcomes remain recorded above and in the review evidence.

After that command exited, the following measurements ran serially. Each returned
0; for the browser commands this means collection completed, not that frame
acceptance passed. The unchanged serial browser startup/crash guard ran for both
collectors. The collector started `validation/server.mjs` with its required
`validation` working directory, verified `/build.json`, and stopped the server
after both browser commands.

```sh
export PATH="$PWD/.tools/bin:$PATH"
just validate > .ci/ski1240-review/validate.log 2>&1
cargo +nightly-2026-09-10 bench --locked --manifest-path validation/benchmarks/Cargo.toml --bench production -- production_physics
node validation/physics-cost.mjs musical-lights-physics/pkg/physics_bg.wasm "$PWD/.ci/ski1240-review/cost.json"
node validation/fullscreen-timing.mjs http://127.0.0.1:8101 "$PWD/.ci/ski1240-review/fullscreen.json"
node validation/active-gap-latency.mjs http://127.0.0.1:8101 "$PWD/.ci/ski1240-review/latency.json"
python3 .ci/ski1240-review/assess-transitions.py > .ci/ski1240-review/thresholds.json
```

The last command returned **1**: applying the unchanged `--expect-clean`
thresholds to the saved transition capture failed the frame budget in all 16
windows. All windows passed its debt and snapshot-age limits. No unchanged
measurement was rerun to replace this result.

Raw evidence stays outside Git under `.ci/ski1240-review/`: `collect.py` reproduces
the serial collection; `commands.json` records exact expanded arguments, UTC
times and exit codes; `criterion.log` and `criterion/` retain all statistical
samples; `cost`, `fullscreen` and `latency` each have a log and JSON capture.
`identity.json` contains per-file build digests, tool versions, source identity
and the native benchmark executable digest. `served-identity.json` independently
checks copied renderer source and hashes every served file. `idle.json` retains
the pre-benchmark CPU sample and process inventory. `measured-site.tar.gz`
preserves the actual served runtime. `SHA256SUMS` binds the retained evidence;
the orchestrator can attach these artifacts to the PR without rerunning them.

| Artifact | SHA-256 |
|---|---|
| Served file-tree digest (`timingIdentity` algorithm) | `0a72750398b4bc6f3c2617f0fb06b3435c4d865eff72bc9ab83b4b8057dbc6fa` |
| Physics WASM | `2950ea64928627ea553ebf96afa130ea355e38e40c989111c03895460f7f2f83` |
| Loudness WASM | `e007c33d5c16b0e0746d580b2f8c6135e217035bc0d5b31c73b8d746382fc32d` |
| Preserved site archive | `eb811b6b9e4bdec1767dcb0e9d574da77fe7015030c0762cde6849393872785c` |

### Matched production workloads

Criterion ran from 12:00:42 to 12:01:14 UTC, before any browser or WASM cost
workload. The preceding three-second CPU sample was 99.88% idle, with no other
build or validation workload running. The repository's unchanged configuration
used 20 samples, one-second warmup and at least three seconds of measurement.
Each native replay covers 240 ticks with identical production audio targets,
palette, eight balls and rise settings; setup/settling are outside timing.

| Workload | 60 cm cap | 2,000 cm cap |
|---|---:|---:|
| Native portrait music, mean (95% CI), ms | 151.50 (150.76–152.46) | 288.10 (286.62–289.87) |
| Native portrait full attacks, mean (95% CI), ms | 73.59 (73.20–74.06) | 170.86 (170.35–171.32) |
| WASM 12-second PCM/resize sequence, requested substeps | 7,369 | 10,963 |
| WASM sequence CPU time, median of three, ms | 1,564.00 | 2,033.36 |
| WASM tall portrait attack, 16 ticks, requested substeps | 106 | 462 |
| Tall attack, maximum requested substeps/tick | 19 | 106 |

The native landscape control measured 138.29 ms (95% CI 137.51–139.18).
Every native workload passed its overload assertion; all WASM cost runs had
zero overload ticks and equal requested/executed substeps. The tall attack
requires 77.06% fewer substeps. PCM and palette digests match the rebase cost
capture above. The existing produced-WASM normalized-attack timing and PCM transport
regressions passed in `just validate`; this report introduces no analysis or
musical-timing changes.

### Served-app transitions and packet-to-render delay

Both caps used seed 1, the generated exercise, diagnostics off and the same
390 × 844 → 844 × 390 → 390 × 844 sequence. Each row summarizes four two-second
enter/landscape/portrait/exit windows. These live wall-clock windows can cover
different tick counts; the fixed-tick comparisons above isolate integration work.

| Browser / cap | Requested substeps | FPS range | Worst p95 frame | Max debt / snapshot age | Worst fraction >25 ms |
|---|---:|---:|---:|---:|---:|
| Chromium / 60 cm | 6,059 | 31.00–36.50 | 50 ms | 8.23 / 70.70 ms | 84.38% |
| Chromium / 2,000 cm | 10,720 | 32.00–37.82 | 50 ms | 8.30 / 61.30 ms | 76.56% |
| WebKit / 60 cm | 6,021 | 21.26–39.82 | 62 ms | 7.00 / 26.00 ms | 100% |
| WebKit / 2,000 cm | 10,411 | 20.75–41.21 | 63 ms | 11.33 / 31.00 ms | 100% |

Requested and executed substeps were equal. These transition captures had zero
overloads, discarded simulation milliseconds and page errors, with audio still
playing and diagnostics off. Neither cap meets the specified frame criteria on
this host. Reduced integration work does not establish smooth-motion acceptance.

The separate instrumented burst capture subtracts the permanent base and measures
packet receipt to the first rendered 10% active-travel crossing, before the next
same-band crossing. Diagnostics are on; these are not FPS acceptance runs.

| Browser / cap | Observed / crossings | Already visible | Not observed (capture ended) | Median / p95 delay |
|---|---:|---:|---:|---:|
| Chromium / 60 cm | 85 / 89 | 0 | 4 (1) | 92.5 / 102.8 ms |
| Chromium / 2,000 cm | 81 / 89 | 0 | 8 (6) | 89.3 / 123.1 ms |
| WebKit / 60 cm | 77 / 108 | 12 | 19 (1) | 65 / 107 ms |
| WebKit / 2,000 cm | 78 / 108 | 12 | 18 (2) | 78 / 118 ms |

Capture-ended responses are a subset of not-observed responses. Quantiles cover
observed responses only. Instrumented Chromium/2,000 cm recorded one overload
tick; the other three captures recorded zero. All four discarded zero simulation
time. This reports latency and missed responses without asserting an unspecified
latency acceptance budget.

### Remaining acceptance and delivery

Current acceptance is the automated contract in [the specification](active-gap-spec.md),
including exact-head browser/GPU CI and provenance-bound artifacts. No human
operator, physical-phone use or smooth-motion confirmation is required. The
older absence of USB-connected phones remains an environment fact.

PR attachment, publication and merge belong to the orchestrator. After merge,
production checks must verify successful Pages completion, latest-main build
identity, direct routes and live cap behavior. A queued job proves no deployment.

## Full browser checkpoint (2026-10-30)

The review-requested complete browser command returned **0** at source checkpoint
`1e5d80ade531c999f33be5c2fa1d9bc2b47dffe3`, tree
`4e0cb6cb1c5fe27beb1c7928b36620dc0b4c8532`. This evidence update changes only
this document. The source and tests were clean and unchanged throughout the run.

From the repository root on Linux, with pinned Node 26.8.2 and Playwright 1.64.1:

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py leptos
python3 validation/validate.py browser
```

Leptos validation returned 0: formatting, WASM/test Clippy, its native unit test,
and the release build with worklet/physics WASM hooks passed. The browser command
ran from 12:39:43 to 13:38:11 UTC and returned 0: **202 offline harness tests and
920 browser tests passed**, with two existing opt-in skips (review-preview
generation and live YouTube). The serial startup/crash guard, one worker and zero
retries were unchanged. All 922 numbered browser results were present exactly
once, including all nine passing active-gap cases across Chromium, WebKit and the
iPhone profile. The previously failing iPhone live-cap case passed in this full
run; its focused result is no longer the only evidence of that repair.

The existing `just check` recipe includes this complete browser command after
the CPU/build checks, followed by the hardware-rendered checks. `just --dry-run
check` confirmed that wiring; it did not execute those other phases. `just
validate` remains the CPU/build/harness subset. No recipe, test assertion,
startup safeguard or CI barrier was changed for this evidence collection.

Retained evidence is in `.ci/ski1240-browser-checkpoint/`, outside Git:
`build-command.json` and `command.json` record exact commands, source checkpoint,
UTC times and exit results; `build.log` and `browser.log` retain their output.
`before.json` and `after.json` bind the served build and source digests before and
after the suite. `verification.json` records complete result numbering and checks
all 98 retained build-file digests. `test-results/` retains browser process and
server-request evidence; `tested-site.tar.gz` preserves the tested site.
`SHA256SUMS` verification returned 0. These artifacts are ready for the
orchestrator to attach to the PR.

| Evidence | Identity / SHA-256 |
|---|---|
| Served build | `1fff442b86d72138748f078c` |
| Served file-tree digest (`timingIdentity`) | `c2cd7c97cac35e4b671d10e9695827367f30f8838c3c6f4b720b6dae269e8f6d` |
| Full browser log | `5e404356515168363fda8ca696d51b5be06023be71926aef7523c15aebec2edc` |
| Tested site archive | `69188c907a4618c4e77dbaadd205e149f7996515f831b6506ea54c6ebbd574d2` |
| Evidence digest manifest | `d14078e21a6a188cdad61e9794ca38018533b72fe2b6043db658b5f4723806b1` |

The initial evidence-wrapper preflight returned 1 before validation or browser
startup: it compared the local site's newer build identity against the earlier
performance producer's receipt. `preflight.txt` records that mismatch. The fresh
pinned Leptos build above established this run's producer receipt; the complete
browser command ran once. Earlier failed full-suite results remain historical
evidence in the sections above.

The physical-access receipt shows only USB root hubs and no `usbmuxd`
connection. No physical-phone performance is established. The prior 16 failing
host frame-budget windows remain failed; this functional browser pass supplies
no replacement performance evidence. Linux CI, live-provider checks and
production verification were not run here.

## Hardware checkpoint execution (2026-10-30)

The review-requested hardware commands were executed once, serially, from the
repository root with `.tools/bin` prepended to `PATH`, at source checkpoint
`45041d569308d4a80267cad2b45f6e7e9ce25d68`, tree
`d46c130b40338137139abd7933c8b64eb20d7c75`. **Hardware acceptance remains
incomplete:** this Linux VM exposes no PCI graphics device or `/dev/dri` nodes.
The installed pinned Node/Playwright and Chromium executables ran successfully;
these failures concern renderer availability, not a missing executable or a
filesystem sandbox denial. The initial load averages were 0.12 / 0.09 / 0.77;
process samples cover the serial run without a competing build or browser suite.

| Command | Exit | Result |
|---|---:|---|
| `python3 validation/validate.py leptos` | 0 | Formatting, Clippy, one native test and fresh release/WASM build passed. |
| `.tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.gpu.config.mjs` | 1 | Renderer preflight: `GPU validation requires a WebGL2 hardware renderer`. No test workers ran. |
| `just validate-tilt` | 1 | All six software samples completed; hardware scene startup failed, producing zero hardware samples. The comparison step did not run. |
| `.tools/bin/node --test validation/harness/gpu-renderer.test.mjs validation/harness/tilt-timing-evidence.test.mjs validation/harness/tilt-lighting-comparison.test.mjs` | 0 | Five tests passed, covering renderer rejection, artifact identity and incomplete/stale comparison rejection. |

Chromium was `156.0.8078.4`. The software renderer was
`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`.
Across the six forward/reverse samples, submitted FPS ranged from 24.64 to 34.60,
p95 frame intervals from 33.4 to 50.1 ms, maximum simulation debt was 8.34 ms
(rounded up), and maximum snapshot age was 6 ms. All samples had zero discarded
simulation time and no page errors. These host samples do not meet the frame
criteria and do not establish hardware or physical-phone acceptance.

The hardware-requested run's CDP GPU identity was
`ANGLE (Mesa, llvmpipe (LLVM 21.1.8 256 bits), OpenGL 4.5 (Core Profile) Mesa 26.0.8-1ubuntu0.3)`.
Its feature status reported OpenGL and WebGL `unavailable_off`; native logs report
`WebGL2 blocklisted`. Three.js reported `Error creating WebGL context` before the
existing 30-second scene-startup timeout. The failure receipt records no failed
requests. This is software fallback on a host without an exposed GPU. No launch
flag, timeout, renderer assertion, serial startup guard, retry count or worker
count was changed. The existing `just check` still requires both hardware phases.

Retained evidence is in `.ci/ski1240-hardware-checkpoint/`, outside Git. Command
receipts and logs record exit results and UTC times; `access.json` records the
PCI/USB inventory and tools; process samples and `gpu-test-results/` preserve
native execution evidence. `tilt-lighting/` contains all software samples and the
hardware failure receipt, including CDP GPU status and scene/request errors.
`before.json` and `verification.json` bind the fresh build and confirm all 88
captured build-file digests stayed unchanged. `measured-site.tar.gz` retains that
site; all 24 evidence files passed `SHA256SUMS` verification. The earlier full
browser pass remains a separate checkpoint and was not rerun for this
documentation-only update.

| Evidence | Identity / SHA-256 |
|---|---|
| Served build | `d7ecf9e317b2c70987874072` |
| Served file-tree digest (`timingIdentity`) | `a4b8d93b68a623fcdaa73cb4a7b0935a13ed8dd58a6fb7def5e943df5327773a` |
| Hardware browser log | `169f82f9b888ff2a54c81568f227ada07a5340ce437b9f1e07982649184251ec` |
| Tilt recipe log | `40cc3daa297dad837aaae94e892c414fe79b5b835a992551fabc202246c6d927` |
| Measured site archive | `d3ca9b43698e87c8441671aaad359e8fba11d9cbeacc0c84664f08c7fe6ae1da` |
| Evidence digest manifest | `1b738f9def5af1aa3de49bfbc4602ec53daa0f950a2a80e2088fa50e1ca5119c` |

The hardware commands failed at this checkpoint. Current automated hardware
acceptance belongs to exact-head GPU CI. The physical-access receipt contains
only USB root hubs and no `usbmuxd` connection; no phone performance is inferred.
No physical-phone run, Linux CI, live-provider check or production verification
was performed in this checkpoint. The superseded manual gate creates no follow-up.

## Matched build and browser checkpoint (2026-10-31)

The review's artifact mismatch is addressed by a fresh build followed immediately
by the complete browser suite. Both commands ran at clean source checkpoint
`3f7149721332df11996085c88ebdd62e2fc21c40`, tree
`541043d475107ab273d485dc2927ee48d92e3e3b`, from the repository root with
`.tools/bin` prepended to `PATH`. The build replaced the review-time artifact
`69fd65930181d2f7820e9f51`; the earlier `1fff442b86d72138748f078c` browser pass
was not reused.

| Command | Exit | Result |
|---|---:|---|
| `python3 validation/validate.py leptos` | 0 | Formatting, WASM/test Clippy, one native test and release build with worklet/physics WASM hooks passed. |
| `python3 validation/validate.py browser` | 0 | 202 offline harness tests and 920 browser tests passed; two existing opt-in skips (review-preview generation and live YouTube). |
| `python3 .ci/ski1240-review-checkpoint-20261031/verify.py` | 0 | All 922 scheduled results appeared exactly once; all nine active-gap cases passed; all 98 captured build-file digests matched. |
| `sha256sum --quiet -c .ci/ski1240-review-checkpoint-20261031/SHA256SUMS` | 0 | All 283 retained evidence-file digests matched. |

The browser command ran from 00:34:00 to 01:34:21 UTC using pinned Node 26.8.2
and Playwright 1.64.1. Source files and served artifacts remained unchanged
throughout. The serial startup/crash guard, one worker, zero retries and all
assertions were preserved. The existing `just check` still requires the full
browser suite and both hardware phases after CPU/build validation.

Evidence is retained outside Git in `.ci/ski1240-review-checkpoint-20261031/`.
Build/browser command receipts record source identity, commands, UTC times and
exit results. `before.json`, `after.json` and `verification.json` bind the same
artifact to the entire run. `test-results/` preserves native browser-process
and server-request logs; `tested-site.tar.gz` preserves the tested site.

| Evidence | Identity / SHA-256 |
|---|---|
| Served build | `84ba3f435da2ae0b3c72a0e3` |
| Served file-tree digest (`timingIdentity`) | `d069e3c2a0627e655bbc4d571dbd657fc00294fec30c9d2b5ba8b9e95c09487b` |
| Full browser log | `dac1f8ceb784ceb4ade70fef9e51e7dc62e9ed229a1aefda3a4bd79f4c183e85` |
| Tested site archive | `44d58026a0d8972a881bb95cd8efe159359c9cf3fa12d299d6c4463e3dd56215` |
| Evidence digest manifest | `176a15523982b5fee7b4f60d0ae03070afa1e5cdcfaa8bf278b8a67cc87cb1da` |

This documentation update records that specific source/artifact checkpoint. It
does not establish equivalence for another build or authorize CI artifact reuse
across source trees. The exact-tree, trusted-producer and digest validation
barrier remains required.

The prior hardware-suite exit 1 (`GPU validation requires a WebGL2 hardware
renderer`) and `just validate-tilt` exit 1 (zero hardware samples) remain failed
evidence for those captures. They were not retried on the same host. The
`physical-access.json` receipt describes that environment only. Current hardware
acceptance runs in exact-head CI; no physical-device operation or human
confirmation is required. Browser emulation establishes no physical-iPhone result.

## Automated evidence revision (2026-10-31)

The protected integration `3e93d8cd52039ed751e5a0a1b2686cc496ea53fc` is preserved.
Read-only verification of both retained SHA256SUMS manifests passed. Existing
geometry, worklet and replay oracles are reused; no musical analysis or physical
integration policy changes. The new collector shares the diagnostic numeric
evaluator, measures submitted frames and records worker inputs for exact replay
at 30/60/120 Hz. It never supplies phone declarations or human confirmation.
GPU artifacts retain complete reports, build digests and collector identity.
`just validate-active-gap` runs cost evaluation, strict transitions and latency
serially against a verified origin. Instrumented latency has no invented budget.

Remote PR #95 still pointed to `3e93d8c` during inspection. Its website run
[41171989315](https://github.com/BlinkyStitt/musical-lights-rs/actions/runs/41171989315)
had passing GPU jobs but a failing Chromium YouTube rotation case: continuity
reported 128 missing and 128 overlapping samples. The validated-site and Pages
jobs were skipped. This baseline is not current-change acceptance or deployment.
The orchestrator owns publication and subsequent exact-head checks.

Local revision checks: root `PATH="$PWD/.tools/bin:$PATH" just validate` exited 0
(42 tooling tests, core/native/WASM/application checks, benchmark correctness and
209 offline harness tests). The subsequently added cost-gate test and collector,
clock and protected comparison regressions passed in a focused 12-test command.
Dioxus again logged its existing `wasm-opt` SIGABRT/unsupported-DWARF error while
its CLI returned success and emitted the app; optimization success is not claimed.

The produced-WASM cost command and saved-JSON evaluator passed: the tall attack
requested 106 capped versus 462 uncapped substeps, with zero capped overloads,
normalized timing within `1e-6` and the same configured deadline. Physics SHA-256
remains `2950ea64928627ea553ebf96afa130ea355e38e40c989111c03895460f7f2f83`.
PCM/palette hashes also match the retained comparison. Core, physics sources and
benchmark inputs are unchanged from the retained statistical checkpoint; no new
statistical CPU claim is made from this contended host. Large logs remain outside Git.

Inventory-only checks found all 922 ordinary cases and 99 unique GPU cases across
two disjoint shards. These are wiring checks, not rendered acceptance. The new
long-run and strict transition/latency checks await published exact-head GPU CI;
no local GPU execution or production deployment is claimed.

The downloaded protected-head tilt comparison also re-evaluated successfully:
hardware shading measured 60 FPS in both orders with p95 16.7/16.8 ms. Its build
was `74999855b09f8c2297613821`, artifact-tree digest
`2e5265577769bc3e02a97c44fc20f61b3c251f55c45bf2bd031c5757ed320220`.
That short, fixed-camera comparison is historical evidence, not the new five-minute
active-gap acceptance. At that checkpoint the conflicting 7 FPS specification
clause was recorded as awaiting a requirement decision. The revised approval
now resolves that historical question in favor of the protected relative-only
software policy, with no absolute software FPS floor; see
[the canonical contract](active-gap-spec.md#approved-software-comparison-policy).

## Approved policy and PCM boundary reconciliation (2026-10-31)

The revised approval retains the existing relative-only software comparison,
including matched 5/8/25 FPS regressions and repeatable 20% slowdown rejection.
Hardware keeps its 59 FPS / 18.5 ms limits. No software-floor decision or manual
acceptance item remains. Read-only inspection confirmed PR #95 still publishes
the preserved integration `3e93d8cd52039ed751e5a0a1b2686cc496ea53fc`; the local
revision descends from it. Its existing Chromium-3 website failure and skipped
validated-site/Pages jobs remain baseline evidence, not current acceptance.

The live PCM test now waits for the worker's applied permanent base and records
the audio sample boundary before requiring 200 later analysis rows. The final
Chromium capture had 448 rows before editing, demonstrating why the former
first-400-only check could miss the change. Both browsers compared exactly 200
post-application rows; neither dropped diagnostic rows.

The first focused run passed Chromium and failed WebKit: after longer collection,
WebKit's audio render thread flushed a subnormal value to zero while Node retained
`1.1694459262607223e-38`. The independent decoded-PCM oracle now also runs on an
audio render thread after live collection. Every captured row must match exactly;
the original Node comparison remains for the first 400 rows. No rounding or
tolerance was added. Both browsers then passed. Batching the 24 exact filtered-band
comparisons per row retained all values while reducing the final run to 11.8 s
in Chromium and 10.9 s in WebKit (24.8 s overall), with the serial startup guard,
one worker and zero retries.

Root `PATH="$PWD/.tools/bin:$PATH" just validate` exited 0: 42 tooling tests,
the core feature matrix, 78 native physics tests, produced-WASM/application
builds, benchmark correctness smoke cases and 210 offline harness tests passed.
Dioxus again logged its existing `wasm-opt` SIGABRT while returning success;
optimization remains unverified. The later changes were confined to browser
test support and documentation; focused browser and Node syntax checks passed.

The produced-WASM cost command passed twice. The first run overlapped the focused
browser check, so its wall-clock measurements are excluded. A subsequent serial
run passed the saved-data predicates: tall-attack work was 106 versus 462 requested
substeps, with zero capped overloads, matching normalized timing and deadline.
Both retained manifests verified (83 and 283 entries). Statistical evidence is
reused only for its original host: core/physics/benchmark sources, manifests,
lockfiles and the pinned compiler match that checkpoint, as do both WASM digests.
No new statistical CPU, hardware GPU, physical-iPhone or deployment claim is made.
Exact-head rendered acceptance and production delivery remain orchestrator checks.
