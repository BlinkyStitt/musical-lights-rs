# Perceived-loudness engineering audit

The browser displays estimated human perceived loudness within a mix. Its bars
use masking-aware partial sones, followed by one shared automatic display scale.
They are not peak/RMS equipment meters. Uncalibrated capture cannot establish
absolute loudness. Calibration does not make a model a measurement of an
individual listener's experience.

This audit supplies reproducible numerical and browser evidence. It does **not**
claim an outside audio engineer's endorsement or listening-panel validation.
Human listening and physical iPhone acceptance remain pending; the user has no
physical iPhone available. Keep the follow-up PR in draft for those checks and
review of the quantified model limitation below.

## Signal-path findings

| Layer | Audit result and evidence |
| --- | --- |
| Capture and calibration | Selected-channel capture prevents phase cancellation by downmix. Actual browser capture settings gate calibrated status; saved profiles bind device, channel, rate and settings. Calibration uses exactly three seconds of RMS and resets the models at a sample boundary. Browser rate conversion and the physical microphone response remain environment-dependent. Existing calibration/session tests cover the software contract. |
| ISO total and specific loudness | The unchanged ISO 532-1 model is checked against all 20 published cases and the pinned independent MoSQiTo implementation. These tests do not certify the separate source-band display. [Reference results](../loudness-results/iso.json). |
| Partial loudness | The pinned deeuu/loudness oracle checks ear weighting, excitation, masking equations and temporal integration. Independent NumPy waveform tests cover tones, noise, bursts, masking and silence. Same-stage tolerances remain `1e-8 + 2e-7 * abs(reference)`; independent-FFT waveform tolerances remain `2e-5 + 2e-5 * abs(reference)`. No fitted gain or time shift. Equal-loudness checks establish agreement between implementations, not new listening evidence. [Existing report](../partial-loudness-results/README.md). |
| Automatic enlargement and smoothing | The shared proportional mapping, gain and One Euro filter are unchanged. New release-WASM comparisons preserve ISO/partial measurements, gain and both target arrays bit-for-bit on all 26 original fixtures and all 14 audit fixtures. |
| Attack accents | Fixed two defects: eligibility depended on screen height, and spectral novelty depended on recording gain despite equivalent calibrated pressure. The detector now takes pressure-scaled features and unscaled sones. Acoustic event decisions and the visual rate limiter have separate diagnostics. |
| Rendering | The white inner border fades linearly over 120 ms. Fill, motion, physics and normal 99-value transport are unchanged. Reduced Motion halves white intensity. Repeated packets cannot renew a pulse. |

The acoustic model preserves the published equations used by the pinned oracle.
The app's disjoint source-band decomposition and FFT front end are adaptations.
In particular, its 24 partial values do **not** sum to ISO total loudness.

## Quantified front-end limitation

[windows.json](windows.json) compares a separately implemented NumPy six-window
front end with the app's fixed window, feeding both into the same unmodified
upstream partial-loudness stages. The reference uses periodic, energy-normalized
64/32/16/8/4/2 ms Hann windows, aligned centers, 4096-point FFTs, 1 ms hops and
10–15001 Hz coverage. The app uses a 42.667 ms window, 2 ms hops and bins through
20 kHz. Source decomposition and downstream equations are held constant. This
isolates front-end differences; it is **not complete GM2002 conformance**.

The historical frequency-slice comparison at 3.4 kHz is 4.429 versus 3.328
sones, about 33% higher for the dominant band. The new
[current-build investigation](current-windows.json) reproduces all seven stored
cases without rewriting [windows.json](windows.json), then varies window length,
FFT grid, frequency coverage, update rate, alignment and source assignment.
Assigning the complete tone to one known source instead gives 4.429 versus 4.671
sones. The 33% difference depends strongly on source-band assignment and does
**not** establish a 33% error in total loudness or human perception.

FFT-grid, coverage and update-rate controls barely change that tone's steady
result. Aligning window centers moves the fixed-window rise90 result from 70 to
80 ms, compared with 82 ms for the multiresolution reference. This alignment is
an explicitly defined analysis geometry control, not a fitted trace shift.
Window length is also varied with a common grid and center to isolate it.
Coverage now includes band boundaries, a 10 ms burst, seeded noise, masking,
separated sources and both licensed music excerpts. Each current-build native
raw-loudness stream is checked against the fixed reference with the unchanged
waveform tolerance. The reference remains an adaptation, not full Cambridge
conformance, and the production DSP is unchanged.

Analysis timing is separate from shared target filtering and the approximately
1.13-second full-height gravity release. Runtime plots and trace exports retain
raw sones, filtered targets, rendered movement and playback timing separately.
Human listening labels and physical-iPhone acceptance remain pending.

## Acoustic decisions and held-out results

[The numerical contract](../loudness.md) specifies every threshold. The detector
uses SuperFlux-style novelty, rising short-term partial loudness, a 0.1-sone
floor, instantaneous/short-term prominence, and a bounded rise reaching a crest.
Prominence and crest tolerances are engineering choices. They can miss weak or
slow audible attacks; absence of an accent must never be interpreted as inaudibility.
These gates do not alter sones or bar height.

Development fixtures include the original bass/treble misses, strong gentle
swell, sustained tones, shallow tremolo, vibrato, masked target and offsets.
Six additional synthetic cases had expected counts recorded before the first
production run in [audit-corpus.mjs](../../validation/partial/audit-corpus.mjs):

| Held-out input | Acoustic events | Flashes |
| --- | ---: | ---: |
| Repeated 250 Hz, 5 ms ramp | 2 | 2 |
| Repeated 3400 Hz, 15 ms ramp | 2 | 2 |
| 1600 Hz, 25 ms rise | 1 | 1 |
| Four articulated 1 kHz notes, 120 ms apart | 4 | 2 |
| Gentle 600 ms rise | 0 | 0 |
| Two 10 ms bursts | 2 | 2 |

The initial complete suite exposed an extra band-3 flash in the development
150 Hz vibrato fixture at amplitude 0.02. A 20% acoustic prominence threshold
was insufficient; the final policy uses 30%. This is an explicitly tuned accent
policy, not a psychoacoustic audibility threshold. After that development
failure, four new confirmation cases were frozen before the final run: repeated
570/7000 Hz tones, 20 ms bursts at 2150 Hz, and a gentle 570 Hz swell. The original
six cases remain regression fixtures; none of their expectations was relaxed.

The articulated sequence's two suppressed events are retained in diagnostics.
The minimum 160 ms interval and 60 ms quiet rearming are visual policy, not a
claim that faster attacks are inaudible. Reciprocal recording-gain/calibration
changes, callback partitions, display enlargement and Reduced Motion cannot
change the tested acoustic decisions. In the baseline, halving PCM amplitude
and doubling calibration changed spectral features by up to 0.608563 despite
equivalent pressure. The corrected producer gives exactly zero difference for
that regression.

On the recovered bass/treble notes, filtering adds 14/12 ms at the 90% target
crossing. A short burst may never reach 90% of the immediate peak; its delay is
reported as null (peak ratio 0.882 for the 10 ms burst), rather than a false zero delay.
The existing 8 Hz jitter test requires peak-to-peak variation at most 0.04 for
0.10 input variation and negligible mean bias. Smoothing remains a presentation
choice that attenuates rapid modulation, not a new perceptual integration model.

## Listening materials and provenance

The earlier temporary preview URLs have expired. Runtime listening review is
available on [Advanced](https://blink.stitthappens.com/advanced/) once this PR is
deployed, using the same two licensed PCM excerpts and optional private local
files. The historical audible comparison below remains a stored diagnostic
artifact, not the live renderer. Human listening judgments remain pending.

[Open the audible comparison](index.html). It replays the exact float32 PCM
used in the release producer and shows previous/current traces on one audio
output clock, mapped from `getOutputTimestamp()` and its performance timestamp.
Playback completion waits for the output timeline to reach the end. If the API
is unavailable or invalid, the page subtracts available base/output latency
estimates and labels timing approximate; without estimates it labels timing
unverified. These fallback runs cannot establish precise flash timing. Exported
notes retain the clock methods and latency estimates for each playback. A
200 ms delayed-output regression checks the actual comparison canvas and its
buffered ending in Chromium and WebKit.

The simplified monochrome bars are diagnostic; [actual renderer
clips](../flash-results/index.html) separately demonstrate the white border.
Playback volume is not calibrated SPL. Review notes can be exported, and there
are no fabricated human annotations or automatic listening passes.

Natural clips were held out from detector development: the available first 5.333 seconds
of “Jazz Trumpet Loops Pack in F 90 bpm” by
[Mihai Sorohan](https://freesound.org/s/77711/) and seconds 8–14 of “Vibe Ace” by
[Kevin MacLeod](https://freemusicarchive.org/music/Kevin_MacLeod/Jazz_Sampler/Vibe_Ace).
Both are [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), obtained from
[librosa/data](https://github.com/librosa/data/tree/38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0/audio),
converted to mono 48 kHz and scaled to peak 0.2. The report records original-file
and exact PCM hashes, transformations and the pinned source revision. Natural
attack counts are observations across bands, not precision/recall scores or
counts of musical notes. Listening labels remain pending.

[audit.json](audit.json) contains code-file hashes, release-WASM hashes, pinned
tool versions, detector configuration, fixture hashes and case measurements.
The PR commit identifies the full source snapshot; the preview build identifier
must match that commit. Numerical evidence can be checked independently of the
preview's temporary URL.

## Automated validation

The [validation record](validation.json) covers 50 core tests in each of four
feature configurations and the Clippy matrix, 26 physics tests, pinned worklet
and Leptos checks/builds, and all numerical reference checks. All **177 browser
checks pass** in Chromium/WebKit with the serial startup guard, one worker and
zero retries. Frame-rate tests cover visible pulses at 30/60/120 FPS, complete
expiry at 120 ms, repeated packets, white inner borders and Reduced Motion.
The production WASM processed four seconds of audio in 782 ms on this Mac
(19.55% of real time), below the existing host budget; this is not phone timing.

## Primary references

The [research and sources overview](../loudness.md#research-and-sources) also
links the partial-loudness and One Euro papers and explains which app behavior
each source informs.

- [ISO 532-1:2017](https://www.iso.org/standard/63077.html): the separate Zwicker total/specific-loudness path.
- [Glasberg and Moore (2002)](https://aes.org/publications/elibrary-page/?id=11081): time-varying loudness and the multiresolution front end.
- [Pinned upstream modules](https://github.com/deeuu/loudness/tree/82de790f79c5b358040861e8bdb906a55009b117/src): the executable partial-loudness oracle.
- [Böck and Widmer (2013)](https://www.cp.jku.at/research/papers/Boeck_Widmer_DAFx_2013.pdf): SuperFlux spectral-difference feature. The app's per-band eligibility and crest rules are adaptations, not results established by that paper.

## Reproduction

The current isolated-window investigation is regenerated by
`python3 validation/validate.py reference`; it writes `current-windows.json` and
checks the historical seven cases without rewriting `windows.json`. The newer
signal coverage includes boundaries, bursts, noise, masking and both runtime
excerpts. Production DSP equations and filters are unchanged.

For the full raw/filtered equality comparison, build the worklet from the
baseline commit recorded in `current-build.json` in a separate checkout using
the pinned toolchain. Preserve its `pkg/loudness.wasm`, build this branch, then
run from the repository root:

```sh
node validation/partial/current-build.mjs /path/to/baseline/pkg/loudness.wasm
```

This checks all 511 values in every trace row for 19 signals in both motion
modes, including the runtime excerpts. It also verifies lazy recording storage.
The live-worklet local-file equality/channel test runs in the full browser suite.
No gain fitting or temporal trace shift is used. Current controls, recordings
and pending physical/listening checks are in the
[Advanced review report](../advanced-results/README.md).

The following commands describe the historical flash audit; they retain its
original baseline and outputs.

Run from the repository root with `.tools/bin` on `PATH`. Preserve the release
WASM and complete site built from baseline `513d615` before building this branch.
Use `.cache/before-flash.wasm` and `.cache/flash-before-site`, respectively.

```sh
python3 validation/validate.py core worklet physics leptos reference
node validation/partial/flashes.mjs .cache/before-flash.wasm
python3 validation/validate.py browser
node validation/partial/flash-demo.mjs .cache/flash-before-site
```

The reference command includes the window comparison. To regenerate listening
artifacts, download the two `.ogg` files named in `audit.json` from its pinned
librosa revision into `.cache/audio-audit/`. Decode with FFmpeg:

```sh
ffmpeg -i .cache/audio-audit/sorohanro_-_solo-trumpet-06.ogg -t 6 -ac 1 -ar 48000 -f f32le .cache/audio-audit/trumpet.f32
ffmpeg -i .cache/audio-audit/Kevin_MacLeod_-_Vibe_Ace.ogg -ss 8 -t 6 -ac 1 -ar 48000 -f f32le .cache/audio-audit/music.f32
node validation/partial/audio-audit.mjs
```

Browser commands on macOS require host access. The serial startup guard, one
worker and zero retries remain mandatory. Automated validation results and
preview checks are recorded separately from physical-phone and listening acceptance.
