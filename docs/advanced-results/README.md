# Advanced controls and listening review

`/advanced` replaces `/phone`; the old route returns the ordinary not-found page.
Home retains its learning content, microphone Listening, Phone motion, Scroll
lights, manual microphone-only Identify song and Fullscreen. FPS appears only
in Advanced diagnostics. The shared renderer, production acoustic model,
filtering, rainbow, scrolling and gravity release remain the same.

When Listening is off, a silent sine signal with a changing frequency and level
runs through the production loudness WASM and its existing display filter, then
the same physics and renderer. This preview opens no AudioContext and requests
no microphone or sensor permission. Listening replaces it with the selected
source; stopping or interruption resumes it. Phone motion remains independent.
Entering Fullscreen also starts Listening from the same action. Exiting leaves
capture running; entering again reuses an active or pending session. Safari's
audio startup is unlocked with a one-sample silent source inside that gesture,
then suspended until the complete analysis graph is connected. The preview
worker remains separate from the capture graph and stops when capture starts.

Display and Input & calibration begin expanded. Physics and Diagnostics begin
collapsed. Reset display changes only scrolling/camera; Reset fields restores
channel 1 and 94 dB SPL while stopped. Forget this calibration and stop deletes
only the current microphone profile key. Physics durations are shown in ms and
converted to seconds internally. Both physics reset actions retain the current
room dimensions. Native checkbox switches have stable accessible names and
44-pixel label targets. Evidence confirmations remain checkboxes.

Music/local-file review preserves selected-channel PCM amplitude, runs directly
through the existing worklet/DSP, and opens no microphone. Source changes require
stopping. Music defaults audible; test tones default silent. Pause, resume,
replay and repeat retain the same connected graph and sample clock. Local files
stay in browser memory. Replacement and page exit release files/buffers.
The two attributed excerpts reuse exact historical audit bytes in versioned
runtime assets. No recognition samples are sent for digital sources.

Listening-note exports include source identity and PCM hash, build/runtime,
playback device, timestamps, clock method/confidence, diagnostic samples and
observations about accents, swells and decay. Output timing is estimated using
`getOutputTimestamp`, otherwise available latency estimates, otherwise marked
unverified. Raw analysis times, filtered targets and rendered geometry retain
separate scales and timestamps. Trace v6 and phone-report v2 exports and physics
replay protocols are retained. Recording storage is allocated only when needed.
Output positions map that clock through pause, resume, replay and repeat changes
before wrapping at a loop boundary or clamping at completion. The preceding
iteration stays visible in exported timing until its audio finishes, and a
completed clip's output position drains to its endpoint. Empty or invalid test
tone parameters block only generated input; licensed excerpts and local files
decode independently of those fields. The production-module transport harness
covers these cases with a six-second clip and 200 ms output delay, alongside
the real Chromium/WebKit source, worklet, transport and export checks.
Rendered samples read the interpolated instance geometry actually drawn, keeping
the physics snapshot separately as `collider`. The plot maps the render host
timestamp into the context clock using the packet's observed timestamp pair,
labels that estimate, and preserves raw timestamps in exports. It applies no
fitted alignment; unverified render times are omitted from the plotted curve.

The five-minute workflow still requires the repeating 24-tone exercise with
recording off, 15-second warmup and the existing 60 FPS/debt/lag thresholds.
Digital music/local files and diagnostic recording are ineligible. Phone reports
use actual user-entered model/browser/OS metadata. 120 FPS is optional.

## Identical-audio previews

- [Scrolling enabled](music-scrolling-on.webm)
- [Scrolling disabled](music-scrolling-off.webm)

Both use the exact same six-second Vibe Ace PCM excerpt and native Listening
action. The production worklet, physics worker and WebGL canvas run normally.
“[Vibe Ace](https://freemusicarchive.org/music/Kevin_MacLeod/Jazz_Sampler/Vibe_Ace)”
is by Kevin MacLeod, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
This excerpt uses seconds 8–14, mono 48 kHz, fixed peak 0.2, as in the stored audit.
The canvas and source stream are recorded with VP9/Opus; this encoding is not a
lossless PCM reference. [Metadata](previews.json) retains the original PCM hash,
build, source identity, processing/output clocks and recording method. Capture
adds overhead and does not qualify as FPS acceptance. These recordings establish
the software paths and provide material for the pending human review.

Regenerate them from a built site with pinned Node and macOS host access:

```sh
MUSICAL_REVIEW_PREVIEWS=1 .tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.config.mjs --project chromium --grep 'record identical music'
```

## Evidence by environment

Pinned local core, worklet, physics, Leptos and reference validation passed,
including 50 core tests in each of four feature configurations, Clippy/build
checks, the ISO/MoSQiTo and partial-loudness references, and all seven stored
window-audit cases. The [current-build equality report](../audio-audit-results/current-build.json)
compares all 511 values of every row in 38 full traces against main, bit for bit.
The [isolated geometry/source audit](../audio-audit-results/current-windows.json)
retains separate controls and expanded signal coverage. Historical results remain
in their original files.
The independent reference CI job validates native production output and records
its executable/source hashes. It reports a WASM hash only when that build is
present; the separate web job builds and tests the actual worklet.

The live local-file test compares 200 raw/filtered frames exactly against an
offline run of the identical decoded selected-channel PCM in both Chromium and
WebKit. Replay after natural completion and the initial recording checks passed
in both browser engines. The follow-up [PR #35](https://github.com/BlinkyStitt/musical-lights-rs/pull/35)
records the completed local browser outcome and current CI result separately.
Run the full suite from the repository root with pinned tools and macOS host
access: `PATH="$PWD/.tools/bin:$PATH" python3 validation/validate.py browser`.
It retains the serial startup guard, one worker and zero retries. The preview
recording test is opt-in and is also run explicitly to generate the files above.
Human listening and physical-device evidence remain pending independently of
software results.

The October 2 playback-review repair passed all 46 Node harness tests and the
pinned Leptos checks/build. Its full macOS rerun passed 326 browser tests with
one skip, but was not fully green: the microphone calibration precision check
returned 14.22945 rather than 14.17572 Pa/unit (tolerance 0.05), identically with
the original reviewed audio module in a controlled baseline comparison. Four
WebKit networking-process `EXC_GUARD` reports were also recorded. The playback
regressions passed in both engines; current CI results are recorded on PR #35.

## Host timing measurements

The October 2, 2026 measurements use pinned Chromium 154.0.8037.0 and WebKit
26.6 on macOS. The recorded build is `14677ab-dirty`: the final source tree with
the render-geometry/clock correction, before the evidence commit. The production
loudness WASM hash remains the one in the equality report. These runs use a
repeating generated-tone exercise with diagnostic recording off, five seconds
of warmup and thirty seconds of measurement per case. They do not substitute for
the fifteen-second warmup and five-minute physical-phone workflow.

| Mac browser profile | View | Mean FPS | p95 frame time | Existing thresholds |
| --- | --- | ---: | ---: | --- |
| Chromium | Normal | 60.00 | 16.8 ms | Pass |
| Chromium | Portrait fullscreen | 60.00 | 16.7 ms | Pass |
| Chromium | Landscape fullscreen | 60.00 | 16.7 ms | Pass |
| WebKit, iPhone profile | Normal | 60.00 | 18.0 ms | Pass |
| WebKit, iPhone profile | Portrait fullscreen | 60.00 | 18.0 ms | Pass |
| WebKit, iPhone profile | Landscape fullscreen | 60.00 | 18.0 ms | Pass |

All six cases meet the existing FPS, frame-tail, simulation-debt, drift and
snapshot-age assertions, with no discarded simulation time or overload ticks.
[Summaries](browser-timing.json), [full samples](browser-timing-detail.json.gz)
and the six profile/view screenshots retain the measurements. The separate
[fullscreen transition run](fullscreen-timing.json) also passes entry,
landscape/portrait rotation and exit budgets in both engines, including the
existing allowance for occasional frames over 25 ms.

The [instrumented latency run](latency.json) retains separate analysis,
receipt, collider and render observations; [full samples](latency-detail.json.gz)
are provided. Analysis reaches 10% of each burst's raw peak in 16–18 ms; transport
age p95 is 4 ms in Chromium and 1.33 ms in WebKit. Later bursts first show 1% bar
height at 61.3–80 ms. The first burst is already above that height before onset:
its 10.7–13.3 ms visual observation describes residual movement, **not** a new
attack latency. The export explicitly flags this condition and retains the
unshifted timestamps. These are software observations, not verified physical
audio-output or human-perception timing.

Regenerate timing artifacts from the repository root with pinned tools and
macOS host access, separately from other browser runs:

```sh
PATH="$PWD/.tools/bin:$PATH" .tools/bin/node validation/phone-timing.mjs https://musical-lights.test docs/advanced-results
PATH="$PWD/.tools/bin:$PATH" .tools/bin/node validation/fullscreen-timing.mjs https://musical-lights.test docs/advanced-results/fullscreen-timing.json --expect-clean
PATH="$PWD/.tools/bin:$PATH" .tools/bin/node validation/partial/latency.mjs https://musical-lights.test docs/advanced-results
```

The phone-timing runner resumes its existing detail file. To collect a fresh
run, preserve the previous timing artifacts elsewhere first rather than mixing
measurements from different source trees.

## Physical-phone and human listening checklist — pending

- Run the repeating tone exercise with recording off and Low Power Mode off.
  Record actual phone model, browser and OS version. Warm up 15 seconds and run
  five minutes each in normal, portrait fullscreen and landscape fullscreen.
  Confirm smoothness and retain exports; target 60 FPS with the existing thresholds.
- Check narrow rows, both themes, switch labels, keyboard focus where available,
  touch targets, direct loads, refresh and Home/Advanced back/forward navigation.
- Enable Listening and Phone motion independently; stop each while the other
  runs. Check denied access, tilt-only access, interruption and page exit.
- From a fresh page, start Listening and clap after several seconds. Confirm
  the switch stays enabled and checked, and the live input changes the bars.
  Repeat by entering Fullscreen while Listening is off; confirm exiting and
  re-entering preserves one capture session. Check Safari on both Mac and iPhone.
- Shake on all axes and tilt in portrait/landscape, with rotation lock on/off.
  Repeat normal/fullscreen with Reduced Motion; automatic scrolling stays off.
- Identify a song with microphone input; confirm the fullscreen title is readable
  and recovery notices remain above it. Digital sources cannot identify songs.
- Listen to the identical excerpt with scrolling enabled and disabled. Check
  accents, swells and decay at a comfortable user-chosen volume; note playback
  device, timing confidence and observations. Verify local stereo channel choice,
  invalid-file recovery, pause/replay/repeat, replacement and note export.

Mac Chromium/WebKit and iPhone profiles are software checks, not physical-phone
or human-perception evidence. No physical-iPhone or listening pass is claimed.
