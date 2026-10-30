# Active gap validation

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

Physical-phone acceptance remains pending: diagnostics off, Low Power Mode off,
15-second warmup followed by five-minute normal, portrait-fullscreen and
landscape-fullscreen runs. Require average FPS ≥59, p95 interval ≤18.5 ms,
under 1% of intervals over 25 ms, no growing debt, no discarded time and human
smooth-motion confirmation. Browser emulation and CPU benchmarks do not meet
that acceptance. Linux CI and production identity/routes/live control verification
remain separate from these local results.

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

These new checks do not refresh the earlier statistical Criterion, served-app
frame/debt/snapshot-age or packet-to-render measurements. Physical-phone runs,
human smooth-motion confirmation, Linux CI and production identity/routes/live
control verification remain pending. No push, PR update, merge or deployment
was performed by this rebase task.
