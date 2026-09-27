# Continuous motion comparison

These are the recorded PR #20 results at `3020a71b44be9f0f7fd995e310a7be91dd9055e4`.
Use that revision to reproduce the protocol-5 after side exactly. The later
gravity-release and balanced-scroll behavior is documented in [physics](../physics.md).

Open [the before/after preview](index.html) locally. It has one shared audio
track, a timeline scrubber, and scrolling on/off. Both panes draw exported
positions from their actual production physics WASM. The front projection is
an inspection aid, not a browser FPS recording or physical-device evidence.

The baseline is `feea54ddad4d8131aa45d3457377bee65675333b` (main before the continuous-motion changes).
`evidence.json` records both physics hashes, the audio hash and exact acoustic
trace comparison. All 2,044,000 trace values match exactly. The worklet binaries
embed their different checkout paths and therefore differ bytewise; the trace
comparison checks the actual values rather than assuming matching file hashes.
The eight-second PCM includes bass attacks, a modulated
sustain, a slow treble swell and treble attacks. Every raw acoustic value,
filtered target and flash timestamp is compared before replay. The old engine
receives its original whole-column mapping; protocol 5 receives source order
and scrolling enablement. Both engines step at 120 Hz with held 60 Hz inputs.

The normalized controller regression compares an 8 Hz, ±0.5% target fluctuation
against the previous controller: travel over ten seconds falls from
1.9848801 to 0.0289083 bar heights, and peak speed from 0.3933585 to 0.0110612
bar heights/second. A sustained slow swell still reaches its exact final level.
Tests retain the ≤50 ms large-stroke arrival check and require stable tiny
corrections to settle exactly within 150 ms. They also cover acceleration
continuity, repeated packets, rapid reversals with balls, source contact color,
scroll recycling outside the enclosure, stop/resume, Reduced Motion and
30/60/120 FPS replay.

Reproduce with separately built baseline and current checkouts. Do not share
package target directories between them: a native check cannot establish that
a packaged WASM belongs to the same source. The browser harness now checks the
built protocol and scroll behavior before native browser launches.

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py core worklet physics leptos
# Host access is required on macOS for both commands below.
python3 validation/validate.py browser
.tools/bin/node validation/motion-preview.mjs /path/to/baseline feea54ddad4d8131aa45d3457377bee65675333b
```

For the last command, replace `/path/to/baseline` with the baseline checkout and
use its full revision as the second argument. Its Leptos and physics
packages must already be built. The generator verifies protocol 3 versus 5 and
writes this directory's audio, trajectories and evidence.

The follow-up uses 8 physical balls with all 24 source bands. The [ball-count
benchmark](ball-count-cost.json) replays the same 12 seconds of generated audio
and five enclosure sizes through both WASM engines, three times each. On an
Apple M4 Max with pinned Node 26.8.2, median simulation CPU fell from 2,552.6 ms
to 707.8 ms (72.3% less); the worst measured tick fell from 10.61 to 3.61 ms.
Both retained all 1,440 ticks at 120 Hz. This is simulation CPU evidence, not
browser FPS or phone acceptance. The display target is 60 FPS; 120 FPS is optional.

The [guarded host browser measurement](fullscreen-timing.json) passed the
existing 60 FPS acceptance thresholds in Chromium and iPhone-profile Mac WebKit
for fullscreen entry, landscape, portrait, and exit. Chromium measured
59.51–60.01 FPS with frame-interval p95 ≤16.8 ms; WebKit measured 60.00–61.00 FPS
with p95 18 ms. Maximum snapshot age was 13.0 ms and maximum simulation debt
8.34 ms. The full local 202-check browser suite also passed; its fullscreen
trace reached 8.07 ms debt and 18.86 ms snapshot age. These results do not
establish performance on Linux CI or physical iPhones.

Reproduce each side with `node validation/physics-cost.mjs PHYSICS_WASM OUTPUT_JSON`
from the repository root, using the recorded engine hashes and pinned tools.

Physical iPhone smoothness, actual sensor response and phone power/thermal
behavior remain unverified. Automated Mac WebKit is reported separately.
