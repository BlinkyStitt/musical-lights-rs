# Continuous motion comparison

Open [the before/after preview](index.html) locally. It has one shared audio
track, a timeline scrubber, and scrolling on/off. Both panes draw exported
positions from their actual production physics WASM. The front projection is
an inspection aid, not a browser FPS recording or physical-device evidence.

The baseline is `feea54ddad4d8131aa45d3457377bee65675333b` (main before this PR).
`evidence.json` records both physics hashes, the audio hash and exact acoustic
trace comparison. All 2,044,000 trace values match exactly. The worklet binaries
embed their different checkout paths and therefore differ bytewise; the trace
comparison checks the actual values rather than assuming matching file hashes.
The eight-second PCM includes bass attacks, a modulated
sustain, a slow treble swell and treble attacks. Every raw acoustic value,
filtered target and flash timestamp is compared before replay. The old engine
receives its original whole-column mapping; protocol 4 receives source order
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
packages must already be built. The generator verifies protocol 3 versus 4 and
writes this directory's audio, trajectories and evidence.

Physical iPhone smoothness, actual sensor response and phone power/thermal
behavior remain unverified. Automated Mac WebKit is reported separately.
