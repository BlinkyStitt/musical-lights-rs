# Visible attack flashes

The correction restores both previously missed 150 Hz and 8600 Hz attacks.
The release producer now qualifies accents from calibrated spectral features
and unscaled partial loudness, independently of bar height or display gain.
The 120 ms linear white inner-border fade preserves colored fills and
half-intensity Reduced Motion. See the [engineering audit](../audio-audit-results/README.md)
for the acoustic rules, model limitations and acceptance status.

| Input | Peak filtered height | Baseline flashes | Current flashes | Current onset latency |
| --- | ---: | ---: | ---: | ---: |
| 150 Hz, amplitude 0.006 | 46.63% | 0 | 2 | 46 ms |
| 8600 Hz, amplitude 0.006 | 56.51% | 0 | 2 | 40 ms |

Each fixture has two 300 ms notes beginning at 0.4 and 1.0 seconds.
[comparison.json](comparison.json) records 26 production-WASM comparisons.
Measurements, gain, immediate targets and filtered targets remain bit-identical.
The original strong gentle-swell regression now passes. The earlier proposed
screen-height threshold and unvalidated 30 ms cancellation guard are not used.

[Before/after clips](index.html) replay each build's release-WASM snapshots
through the actual Leptos renderer at controlled 30 FPS audio timestamps.
They are silent render demonstrations, not live microphone or phone captures.
The baseline site predates the squash merge; its worklet hash matches a fresh
build from `513d615`. Current acoustic timings differ from the earlier experiment.

Run `validation/partial/flash-demo.mjs` after building both sites, then encode
its four PNG sequences with FFmpeg at 30 FPS, H.264, yuv420p and fast-start MP4.
The [audible diagnostic comparison](../audio-audit-results/index.html) supplies
actual audio and a notes exporter for later human review.

No physical iPhone is available. A desktop WebKit run or iPhone browser profile
does not establish physical-phone visibility. Keep that acceptance pending.
