# Fullscreen resize and notice correction

Fullscreen used to change the simulated enclosure from 0.928 m to 2.597 m
immediately on a 390 × 844 viewport. That retargeted raised bars over their
40 ms musical stroke and could exceed the contact integration budget. The
new simulation applies a requested enclosure height over 36 fixed 120 Hz
ticks (300 ms), using a smoothstep curve. Repeated requests do not restart it;
retargeting starts from the current applied height. Body positions, velocities,
radii, collision handling, and elapsed simulation time are preserved. The
ceiling continues to wait for occupied space when shrinking.

This is a layout transition, not added loudness integration. The existing
40 ms musical response and 320 ms Reduced Motion response are unchanged.
The 33-number input still carries requested height in its last slot; the
snapshot's height is the applied height. Replay advances the transition in
simulation ticks, independently of rendering FPS. Canvas resizes are coalesced
per animation frame, and unchanged dimensions do not reallocate the renderer.

## Evidence and limits

Native regressions cover raised bars at constant input, enlargement, shrinking,
retargeting, repeated packets, containment, and identical replay at 30/60/120 FPS.
The controlled resize must produce zero capped integration ticks. Existing
musical stroke, momentum, collision, ceiling, and deterministic replay tests
remain in force.

The [host transition measurements](timing.json) and
[raw frame samples](timing-detail.json.gz) cover the actual changing 24-tone
workload with diagnostics off. Sampling starts before entering fullscreen and
includes rotation to landscape, return to portrait, and exit. The baseline is
published build `513d6159f960f1436aab087563e2f94b74584dc1`; the candidate is the
source change accompanying this report. Both use the iPhone-style CSS fullscreen
fallback. Browser versions are recorded in the JSON.

| Candidate browser | FPS across transition windows | Worst frame | Maximum simulation debt | Maximum snapshot age |
|---|---:|---:|---:|---:|
| Chromium on Mac | 60.00–60.01 | 16.8 ms | 7.93 ms | 12.6 ms |
| WebKit on Mac, iPhone profile | 59.97–60.50 | 18 ms | 8.00 ms | 17 ms |

All candidate windows meet the existing 59 FPS, 18.5 ms p95, below 1% of frames
over 25 ms, below two simulation ticks of debt, and below 100 ms snapshot-age
budgets. No simulation time was discarded and audio remained playing.

The baseline also delivered approximately 60 FPS on this Mac. These host results
show that the resize repair stays within budget; they **do not establish that a
physical iPhone's stutter is fixed**. Physical-device smoothness is pending.
Changing music can still exceed the integration limit independently of resizing:
WebKit recorded some such ticks, including ones more than 1.8 seconds after
entry, when the resize was already complete. The counters are retained. The
constant-input resize regression and live-music timing test intentionally check
different contracts.

## Notices and stopped states

A temporary incident notice expires after four seconds. Further reports during
the same incident neither restart its timer nor redisplay it. One continuous
second of healthy metrics rearms physics notices. A historical nonzero overload
counter no longer keeps a warning visible forever.

Microphone and fullscreen error details also expire after four seconds. When
an error actually stops audio or graphics, a compact stopped status and recovery
hint remain. Phone-test progress/results and cumulative metrics are retained.
Timers are cleared on replacement, recovery, and component cleanup.

## Reproduction

Run commands from the repository root with `.tools/bin` on `PATH`:

```sh
python3 validation/validate.py core worklet physics leptos
python3 validation/validate.py browser
node validation/fullscreen-timing.mjs https://blink.stitthappens.com .cache/fullscreen-before.json
node validation/fullscreen-timing.mjs https://musical-lights.test .cache/fullscreen-after.json --expect-clean
```

On macOS, browser commands require host access. Keep the serial startup guard,
one worker and zero retries. `musical-lights.test` is the existing in-process
static preview harness serving the built candidate.

The listening-review clock correction is documented in the
[audio audit](../audio-audit-results/README.md). Its delayed-output regression
checks the actual comparison canvas; human listening approval remains pending.

Validation for this change passed: 50 core tests in each of four feature
configurations, 28 physics tests, the pinned worklet and Leptos checks/builds,
and all 184 Chromium/WebKit tests with the serial startup guard. The delayed
output clock also has focused Node checks for fallback and suspend/resume.
The release loudness WASM remains byte-identical to the 40-fixture audio audit
(SHA-256 `c5c30c9f44272427e9a5a903bd34a224c258b5d04ab33019ed81d0d983b9c9df`).
