# Audio, loudness, and light

## One measurement contract

Browser, terminal, IDF net, and Rust STM32 jacket use `audio::processor::LoudnessProcessor`. It owns the existing ISO 532-1:2017 time-varying meter, one visual gain, shared presentation, acoustic attack features, and causal tempo estimation. The browser no longer runs a separate FFT partial-loudness model.

Input is mono PCM at 48,000 samples/s. Calibration supplies pascals per PCM unit. Without a measurement, the explicit assumption is 2 Pa/unit: RMS 1 represents 100 dB SPL. Uncalibrated sones are conditional estimates. The default sound field is free field; diffuse-field reference support remains available. This monaural model does not model hearing loss or individual listeners.

The meter runs **28 third-octave filters**, with f64 states and three power integration stages. Their time constant is `2 / (3 × min(center_hz, 1000))`. Threshold corrections, nonlinear decay, masking spread, and temporal weighting produce total sones and **240 specific-loudness samples**, spaced at 0.1 Bark across 0–24 Bark. Each consecutive ten samples forms one one-Bark display integral. This is why 28 internal filters produce 24 display bands. Bark and ISO are parts of the same method.

The output grid advances every 96 samples (2 ms). Two interpolation stages require 48 samples of lookahead (1 ms). Neither quantity is the full perceptual integration time. Low-frequency filters respond over longer intervals. A transient can be brief while still containing oscillation and decay; measure its response rather than assuming any frequency analyzer is instantaneous.

One tone can produce a hill across adjacent Bark regions. Auditory excitation and masking spread cause this behavior; the bars do not represent isolated pitches. Approximate Hz labels describe positions on the Bark scale. They do not impose disjoint frequency slices on the input.

The reported total retains the model's temporal weighting and rounding. Do not reconstruct it by summing scaled or filtered visual bars. For identical PCM, calibration, sound field, and settings, callback partitions cannot change the model output. Empty/non-finite input and discontinuities fail explicitly. The low-frequency reference correction stops above its 120 dB SPL domain. Missing samples require a reset.

## Input and calibration

The browser builds its full graph while the context is suspended, then starts the audio clock. It requests a 48 kHz AudioContext and disables automatic gain, echo cancellation, and noise suppression. It checks actual track settings. Unknown or enabled processing keeps the input uncalibrated. A selected input channel supplies the signal; opposite-phase channels cannot cancel through downmixing. Web Audio converts the track's native rate to the analysis context rate.

Open **Advanced → Input & calibration**, choose the input channel before capture, and supply the known steady reference level in dB SPL. Keep microphone placement and input gain fixed. The measurement uses exactly three seconds of RMS input. Silence, clipping, and invalid levels fail. The scale is `20e-6 * 10^(reference_dB/20) / measured_RMS`. The browser applies it at an exact sample boundary and binds a saved profile to the device, channel, context rate, and complete reported track settings. A changed track setting, mute, ended track, or processor failure stops the session. The browser cannot detect a physical gain change that the device does not report; repeat calibration after such a change. Blocked local storage permits calibration for the current session only.

The terminal requests 48 kHz and uses the default channel numbered 1. Other supported rates of at least 44.1 kHz pass through the pinned 128-tap, 90 dB `resampler` FIR. The stream retains history across callbacks. Sixty-three zero prehistory samples align the upstream FIR center; its remaining 1/1024-input-sample phase precision is at most 23 ns at 44.1 kHz. Tests bound the resulting callback-dependent PCM roundoff at 0.0001 for a 1 kHz, amplitude-0.5 tone. The loudness model itself gives bit-identical frames for the same PCM stream under all tested partitions. Native clipping checks include both integer rails.

Delivered sample counts control native processing and calibration timing. CPAL 0.18.2 does not expose capture timestamp precision. Its ALSA fallback can use a scheduler clock, so timestamp differences cannot reliably identify missing samples. Driver errors, including ALSA `Xrun` reports, permanently fail the session; a three-second callback stall also stops reads. Loss that the backend does not report remains undetectable. CPAL cannot query hardware gain or processing, so measured profiles require an operator-supplied fixed-settings description and an exact device/channel/rate/format match.

From `musical-terminal`:

```sh
cargo run --release --locked -- --channel 1
cargo run --release --locked -- --channel 1 --reference 94 --save reference.json --settings 'Device gain 40%; audio processing off'
cargo run --release --locked -- --channel 1 --profile reference.json --settings 'Device gain 40%; audio processing off'
```

The ESP32 uses 48 kHz, Philips mono left-channel, signed 16-bit input on BCLK 26, WS 33, DIN 25. The application owns the ESP-IDF receive channel directly so its interrupt callback can report DMA overflow. A read error or overflow stops the measurement and clears the panel. The input must match the microphone's actual wire format; confirm it on hardware before treating it as a measurement.

## Shared presentation and attacks

Raw band integrals are sones. Targets, filtered targets, and physical travel are separate values. A common visual gain seeks 80% activity for the strongest band, stays between 1/64 and 64, adapts downward over 2 s and upward over 20 s, and freezes below 0.1 total sone. A common headroom scale preserves band ratios. There is no per-band normalization, fitted frequency gain, or noise subtraction.

The shared-coefficient 1 Euro filter defaults to minimum cutoff 1 Hz, derivative cutoff 1 Hz, and beta 0.8. All bands use the largest derivative to choose one coefficient. The filter changes presentation only. Browser physics then follows these targets using its configured bar travel duration. Hardware samples the same canonical snapshot at its own display rate.

Attack novelty is the positive difference in `log10(1 + band_sones)` over 10 ms. A bounded adaptive baseline spans 100 ms; the recent peak spans 30 ms. Default eligibility requires 250 ms startup, novelty above baseline by 0.01 and at least 15% of current log loudness, at least 0.1 sone, and at least 30% of the strongest band. A pending candidate lasts at most 60 ms and must reach a crest: the value 10 ms earlier must be at least 95% of the current value, while band loudness has risen from the candidate baseline and total loudness has not fallen below its value when the candidate started. The total check prevents release-time spectral spreading from masquerading as a new attack. Acoustic rearming needs 10 ms quiet. Visual flashes additionally require 160 ms spacing and 60 ms quiet, then decay linearly over 180 ms. Reduced Motion halves the edge intensity.

These thresholds are engineering defaults, not hearing thresholds or ISO requirements. The detector sees raw canonical loudness, never visual gain, height, or ball motion. Sustained tones, gentle swells, modulation, offsets, and short articulations have separate regression cases. Multiple hearing bands may respond to the same articulation. Recent-peak accent eligibility compares a candidate rise with the preceding raw-loudness peak. It waits for acoustic confirmation and coalesces bands over 60 ms before a direction-probability draw. Unconfirmed candidates cannot draw.

Tempo uses the same novelty stream, aggregated to 50 Hz, in a bounded causal autocorrelation estimator. Defaults search 60–200 BPM using eight seconds of history, three-second smoothing, and a two-second loss period before easing toward 60 BPM. This does not implement a beat-phase tracker or Ellis's complete dynamic-programming method. The continuity prior is symmetric for faster and slower candidates and favors the retained musical period over weaker subdivisions. Near-equal shorter periods suppress redundant slower multiples, including the nearest lag bin at the 200 BPM boundary. After the confidence-loss hold expires, the old octave preference is released for reacquisition; the history and smoothed output remain continuous.

Continuous, independently labeled 32-second excerpts of Kevin MacLeod's “Carefree” (96 BPM) and “Monkeys Spinning Monkeys” (144 BPM) are regression fixtures. Their [provenance manifest](../musical-lights-core/tests/fixtures/tempo/manifest.json) records archived source hashes, composer labels and exact transformations. Accuracy checks use production PCM analysis at every half-second checkpoint from seconds 24–32, including a single Carefree→Monkeys splice without reset. This demonstrates those excerpts, not universal music accuracy; octave and other subharmonic ambiguities remain possible. In a separate synthetic 120→180 BPM pulse transition, both the original and repaired estimators settle near their common 60 BPM period, although a fresh 180 BPM train acquires normally. The delivery fixture uses 100→150 BPM and does not claim to solve that pre-existing ambiguity.

The net combines the first five filtered bands into one row and applies one common layout headroom scale. The jacket maps row `r` to `floor(r × 24 / 32)`. These are physical layout operations; neither creates a different measurement or detector.

## Readouts and controls

Current RMS dBFS uses exponential power integration, default 125 ms. Silence has a finite transport floor of −160 dBFS. Current sones come directly from the ISO meter. A bounded readout-only history uses 100 ms buckets and the lower tenth percentile over 30 seconds. It reports background sones and RMS dBFS separately, shows learning until the history fills, and resets with a new source or processing reset. Digital playback labels it as an input background estimate, not room noise.

The background estimate never feeds the model, gain, attack detector, or calibration. dBFS cannot determine safe exposure. Absolute acoustic sones require measured microphone sensitivity and fixed capture settings.

Advanced controls expose gain, smoothing, attack history and gates, flash timing, tempo range and response, RMS integration, background history and percentile, numeric updates, and display packet rate. The core validates all settings before use. ISO coefficients and band definitions stay fixed. Audio settings apply on the next explicit audio start. Latency and block requests are browser-dependent hints. Default uses the browser quantum, normally 128 samples (2.67 ms at 48 kHz). Unsupported requests remain unavailable. The UI reports actual block size. No setting inserts silence or drops input to hide an overrun.

## Rendering

Auto depth measures observed frame cadence, tests bounded increasing counts, then freezes the largest passing count. It lets the scene settle for 500 ms before measuring a one-second baseline, then lets each depth settle for 500 ms and samples it for at least 1.25 seconds and 60 frames.

It requires at least 95% of the measured cadence, a 95th-percentile interval below 1.25 refresh periods, and no more than 5% long intervals above 1.5 refresh periods. A failed window must fail a second measurement at the same depth before Auto lowers its choice. The full test stops after 25 seconds at its best completed count.

Auto does not infer GPU speed from CPU or memory hints. Saved counts remain manual; Auto explicitly starts a measurement. Hiding the scene, hiding the page, or losing its graphics context stops a measurement at its best completed count. Select Auto again to start a new measurement when the scene is visible.

The nine-box field is 10.8 units wide. At the default 0.24-unit box depth, 44 depth images plus the physical box give the same 10.8-unit depth. Startup Auto still selects 1–32 images; manual depth and an explicit Auto test retain the full range.

A bounded field uses 24 paired light strips and eight physical ball sources. Bars emit their palette colors; balls emit their pigment colors. Both ends of each paired strip light nearby surfaces. White attacks illuminate nearby surfaces through the full tunnel depth. The shader samples the field at mesh vertices and interpolates across faces. The single outer coating has fixed subdivisions. All nine banks and translated depth images reuse these sources. There are no additional physical balls, per-copy light objects, shadow maps, recursive reflection cameras, or bloom passes. Controls expose glow, spill strength/range, depth fade, resolution, camera sweep, and scrolling speed.

**Lighting & rendering → Bar attack glow** controls white emission along bar attack edges, from 0 to 3. The default is 1, up from the previous fixed strength of 0.8. It applies immediately and persists with display preferences. Acoustic attack detection, quiet bar color, and the rising-side preview envelope retain their existing inputs. **White attack light strength** controls light cast onto nearby surfaces separately.

## Scientific sources and implementation roles

- [ISO 532-1:2017, Zwicker method](https://www.iso.org/standard/63077.html) defines the authoritative time-varying loudness calculation. The application uses its existing implementation rather than mixing loudness models.
- [MoSQiTo's time-varying implementation](https://mosqito.readthedocs.io/en/latest/source/reference/mosqito.sq_metrics.loudness.loudness_zwtv.loudness_zwtv.html), pinned in the reference environment, provides an independent numerical comparison for total and specific loudness. MoSQiTo 1.2.1 supplied the adapted tables and equations under Apache-2.0. Its documentation identifies the method's normative use of ISO 226:1987 contours. Do not add an arbitrary modern equal-loudness boost on top.
- [Moore (2014), Development and Current Status of the Cambridge Loudness Models](https://journals.sagepub.com/doi/10.1177/2331216514550620), DOI 10.1177/2331216514550620, explains overlapping auditory filters, level-dependent excitation spread, and the distinction between specific and partial loudness. It supports the interpretation; it does not supply an additional active model.
- [Bello et al. (2005), A Tutorial on Audio Transient Detection](https://www.research.ed.ac.uk/en/publications/a-tutorial-on-audio-transient-detection/), DOI 10.1109/TSA.2005.851998, supplies onset-detection principles. The application's canonical log-loudness detector is an engineering adaptation, not a reproduction or validated auditory onset model.
- [Ellis (2007), Beat Tracking by Dynamic Programming](https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf), DOI 10.1080/09298210701653344, informs autocorrelation tempo estimation. The application uses a causal bounded adaptation and does not claim the paper's full beat tracker.
- [Casiez, Roussel, and Vogel (2012), 1 Euro Filter](https://gery.casiez.net/1euro/), DOI 10.1145/2207676.2208639, supplies visual smoothing equations. The shared coefficient across bands is an application adaptation.
- [Web Audio specification](https://www.w3.org/TR/webaudio/) defines audio contexts, worklets, block-size requests, and latency hints. Actual support and delivered block sizes require browser checks.

Standard loudness equations, adapted detector/filter methods, and artistic lighting have different roles. Numerical reference agreement does not prove perfect perception, microphone calibration, phone frame rate, or physical-device operation.

## Historical evidence

The checked-in partial-loudness, fixed-window, spectrum, and audio-audit reports describe earlier implementations. Their images and results remain unchanged. They do not describe the current filter-only production path. Run current validation commands from [validation guidance](validation.md); do not use an old report's transport layout as the active contract.

## Manual gate, gain modes and live tuning

The microphone noise gate is disabled by default. Its default floor is −60 dBFS,
with a permitted range of −90 through −20 dBFS. A fixed 10 ms RMS detector opens
at 3 dB above the floor and closes after 100 ms below the floor. Digital playback
bypasses it. A closed gate eases sound targets toward zero, freezes automatic
gain, suppresses new attack and direction events, and feeds silence to tempo.
Raw loudness, calibration and the separate decorative listening wave continue.
The gate changes display policy; it does not subtract noise from measurements.

Normal gain retains the production behavior. Vivid uses one quarter of the
configured gain time constants; Lazy uses twice those constants. Off permits
manual visual gain from 1/64× through 64×, default 1×. One shared multiplier
preserves band ratios and calibrated loudness. The 28 audio tuning values retain
their saved format; the four validated visual options have a separate record.

Processing changes carry a session ID and revision. The worklet applies a complete
validated update at the next fixed analysis boundary and acknowledges that revision.
It keeps filters, history, calibration and sample continuity. The changed frame
cannot create an attack event. Obsolete sessions and revisions are rejected.

Block-size and latency changes recreate an active AudioContext. Digital source,
sample position, pause/repeat and monitor state survive. Stop, route cleanup and
newer settings cancel obsolete acquisition and restart work. Changing saved settings
while stopped does not start audio. Restart cancels incomplete calibration and
retains the last accepted profile for matching input settings.
