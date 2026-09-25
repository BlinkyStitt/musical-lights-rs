# Audio, loudness, and light

The live browser, terminal, and ESP-IDF application use one ISO 532-1:2017 time-varying Zwicker implementation. The measurement stage returns total loudness in sones and 240 specific-loudness values in sones/Bark. Terminal and hardware displays use the ISO specific-loudness integrals. The browser uses a separate source-band partial-loudness measurement for its bars. Adaptive display gain never changes the measured values.

A 20 ms RMS window is not sufficient for every frequency. It covers one cycle at 50 Hz and less than half a cycle at 20 Hz. The model instead uses the specified third-octave filters and frequency-dependent power integration, followed by the specified temporal loudness stages. Its output interval is 2 ms; that interval is not its integration duration.

## Measurement contract

- Input is mono PCM at exactly 48,000 samples/second. Signed 16-bit PCM uses division by 32768. Float PCM above nominal full scale remains intact; a counter reports samples with absolute value at least one.
- Calibration supplies pascals per PCM unit. Without a measurement, the explicit assumption is **2 Pa per unit**: an RMS input of one represents 100 dB SPL. The user interface labels this state **Uncalibrated**. Its sones are conditional on that assumption, not measured environmental loudness.
- The default field is free field. Diffuse field supports the corresponding reference case. This is a monaural model, not a binaural or hearing-loss model.
- Twenty-eight third-octave channels use f64 filter states and power. Their three power low-pass stages use `tau = 2 / (3 * min(center_hz, 1000))`. Core loudness, nonlinear decay, upward masking slopes, and final temporal weighting follow the reference method.
- Every frame has an input sample index. The frame grid starts at the supplied first sample and advances by 96 samples. Two interpolation stages require 48 samples of lookahead. `finish()` emits any final frame on the input grid; it does not append an artificial silence tail.
- Callback size never defines a measurement window. Empty or non-finite blocks fail before model updates. Missing samples require an explicit reset. Out-of-domain levels stop analysis instead of returning plausible looking numbers. The reference algorithm limits its low-frequency correction to 120 dB SPL.
- For terminal and hardware displays, every ten adjacent specific-loudness bins form one 1-Bark display band. The panel sums the first five band integrals before display scaling, then retains the other nineteen bands. Specific loudness is the model's spectral output; the time-weighted total is not recomputed from the visual bars.

## Input and calibration

The browser builds its full graph while the context is suspended, then starts the audio clock. It requests a 48 kHz AudioContext and disables automatic gain, echo cancellation, and noise suppression. It checks actual track settings. Unknown or enabled processing keeps the input uncalibrated. A selected input channel supplies the signal; opposite-phase channels cannot cancel through downmixing. Web Audio converts the track's native rate to the analysis context rate.

Open **Input calibration**, choose the input channel before capture, and supply the known steady reference level in dB SPL. Keep microphone placement and input gain fixed. The measurement uses exactly three seconds of RMS input. Silence, clipping, and invalid levels fail. The scale is `20e-6 * 10^(reference_dB/20) / measured_RMS`. The browser applies it at an exact sample boundary and binds a saved profile to the device, channel, context rate, and complete reported track settings. A changed track setting, mute, ended track, or processor failure stops the session. The browser cannot detect a physical gain change that the device does not report; repeat calibration after such a change. Blocked local storage permits calibration for the current session only.

The terminal requests 48 kHz and uses the default channel numbered 1. Other supported rates of at least 44.1 kHz pass through the pinned 128-tap, 90 dB `resampler` FIR. The stream retains history across callbacks. Sixty-three zero prehistory samples align the upstream FIR center; its remaining 1/1024-input-sample phase precision is at most 23 ns at 44.1 kHz. Tests bound the resulting callback-dependent PCM roundoff at 0.0001 for a 1 kHz, amplitude-0.5 tone. The loudness model itself gives bit-identical frames for the same PCM stream under all tested partitions. Native clipping checks include both integer rails.

Delivered sample counts control native processing and calibration timing. CPAL 0.18.2 does not expose capture timestamp precision. Its ALSA fallback can use a scheduler clock, so timestamp differences cannot reliably identify missing samples. Driver errors, including ALSA `Xrun` reports, permanently fail the session; a three-second callback stall also stops reads. Loss that the backend does not report remains undetectable. CPAL cannot query hardware gain or processing, so measured profiles require an operator-supplied fixed-settings description and an exact device/channel/rate/format match.

From `musical-terminal`:

```sh
cargo run --release --locked -- --channel 1
cargo run --release --locked -- --channel 1 --reference 94 --save reference.json --settings 'Device gain 40%; audio processing off'
cargo run --release --locked -- --channel 1 --profile reference.json --settings 'Device gain 40%; audio processing off'
```

The ESP32 uses 48 kHz, Philips mono left-channel, signed 16-bit input on BCLK 26, WS 33, DIN 25. The application owns the ESP-IDF receive channel directly so its interrupt callback can report DMA overflow. A read error or overflow stops the measurement and clears the panel. The input must match the microphone's actual wire format; confirm it on hardware before treating it as a measurement.

## Display contract

One slow gain follows the strongest of the 24 bands. Its target maps that band to 80% activity. Gain stays between 1/64 and 64, changes downward with a 2 s time constant and upward with a 20 s time constant, and freezes below 0.1 total sone. Band targets are proportional: `band_sones * min(gain, 1 / peak_band_sones)`. Headroom limits the common scale for all bands; no band clips independently. The shared gain seeks `0.8 / peak_band_sones`. The panel applies the same rule after bass aggregation, with one common scale across its rows. These values are **artistic activity**, not loudness units. A steady tone remains visible; the gain does not learn it as noise.

The browser assigns partial loudness to 24 disjoint source frequency ranges.
A calibrated selected channel feeds a causal 2,048-sample periodic Hann window
at 48 kHz, advancing 96 samples at a time. Positive FFT-bin power is partitioned
once, by bin center, using the existing frequency boundaries. Components from
15.5–20 kHz remain background for all bars. The 42.67 ms window includes zero
prehistory at session start; its timestamp is the end-exclusive sample clock.
Its center lies 21.33 ms before that timestamp, separately from temporal response.

The Moore–Glasberg–Baer partial-loudness calculation uses free-field outer/middle
ear weighting, monaural presentation, and 149 auditory filters spaced by
0.25 ERB from 1.8 Cam. The entire mixture determines each level-dependent filter
shape. Each source slice's excitation is compared with all other slices,
including the high-frequency background, then integrated across auditory filters
into one value for that source band. The high-level branch uses the original
MGB1997 square-root equation (the oracle's ANSI-2007 extension is disabled). Glasberg–Moore short-term integration uses
`tau_attack = -0.001 / ln(0.955)` and `tau_release = -0.001 / ln(0.98)`;
at the 2 ms hop the coefficients are `1 - 0.955²` and `1 - 0.98²`.
These 24 partial values **do not sum to ISO total loudness**. Assigning them to
source bands is this app's representation, not the ISO specific distribution.

One unchanged adaptive gain and common headroom scale map those values to targets.
The ISO total still controls the existing 0.1-sone gain-adaptation eligibility.
No thresholds, sharpening, per-band normalization, or decorative height smoothing
are added. White-edge attacks use measured short-term partial loudness.
The terminal, LEDs, `LoudnessFrame`, calibration, and all 240 ISO values retain
their original behavior. The independent reference and selectivity results are
in [the partial-loudness report](partial-loudness-results/README.md).

Each bar keeps its fixed HSLuv color and rounded collider geometry. Rapier's
rigid spheres receive contact impulses from the actual moving bars; rendering
uses the collider transforms. The top remains open and visual headroom is 5%.

White edges have their own acoustic peak state, independent of display gain. A new acoustic rise above that peak starts a 350 ms edge hold, followed by `(1 + r*t) * exp(-r*t)` with `r = 30/s`, or `20/s` with Reduced Motion. This timing never holds a height. Removing the height hold removes the former combined bar/edge flash-rate guarantee; the fast bar response must be assessed visually with the tone page. Reduced Motion uses slower physical strokes.

The browser runs analysis in its own AudioWorklet WASM instance. It preallocates its input and state buffers and imports no browser functions into WASM. The current snapshot has 122 f64 values (976 bytes): audio seconds and Reduced Motion, then current target, acoustic peak sones, edge hold deadline, edge opacity, and current input sones for each of 24 bands. At most one display message waits for acknowledgement; analysis continues through page stalls.

Optional v2 diagnostics attach at most 64 rows of 438 f64 values to the same
acknowledged packet. Rows distinguish ISO sample index, total sones, all 240
specific values and 24 integrals; partial window-end sample, 24 instantaneous
and 24 short-term values; shared gain; and the display snapshot. Each packet
has its audio-session identifier and trace version. Lost rows are counted.
Recording caps storage at 50,000 rows and 25,000 physics snapshots. Every input
start, including microphone restarts, resets buffers and source metadata; stale
session packets are rejected. Diagnostics must be off for phone FPS acceptance.

[Physical bars](physics.md) use a 40 ms rest-to-rest stroke and must arrive within
1% within 50 ms of physics input receipt. The causal analysis window, perceptual
integration, ISO lookahead, transport, physics receipt, and rendering are separate
latency boundaries. Reduced Motion retains its 320 ms stroke.

## Color and physical output

Palette coordinates use standard HSLuv. Conversion uses the reference D65 constants and matrices, then keeps linear sRGB floats through brightness mapping. The browser applies the sRGB transfer function once at CSS output. LEDs apply a validated per-channel inverse response and white-balance profile once before byte quantization. The default LED response assumes linear PWM and is explicitly unmeasured. HSLuv coordinates are never copied into HSV fields.

The 20×20 panel retains the wedding palette, 8/255 ambient light intent, and 128 drive cap. Scrolling uses elapsed seconds and the original row rate. `light-check` emits red, green, blue and white ramps up to the application cap, followed by 100 ms white pulses at one-second intervals. Compile it with the other firmware binaries; it does not run or flash as part of validation.

`validation/lights/profile.py` generates `musical-adafruit-sparkle-idf/src/light_profile.rs` from measured data. LED CSV columns are `channel,drive,light`. Each channel needs at least 17 strictly increasing measured points covering the full 0–255 device response; the application still caps drive at 128. Measure full-range response on a suitable bench setup. The generator subtracts measured black, normalizes each channel, and inverts the curve at 17 equal light steps. Supply measured white-balance factors separately. Optional microphone Pa/unit requires its device, wiring, bit-format, channel and gain description. Retain those measurements with the deployment profile; do not infer a profile by eye.

## Evidence and limits

Run `python3 validation/validate.py all` with the documented toolchains. Its `reference` target downloads the unchanged ISO supplementary archive, verifies SHA-256, and tests all twenty time-varying cases (6–25). It compares at published timestamps without fitting a delay or scale. The reference tolerance is the larger of 0.2 sone or 10% at every point, and the larger of 0.1 sone or 5% for at least 99% of points. Comparisons against the separate MoSQITo Python implementation cover cases 6, 10, 13, and 15, including every specific-loudness bin. Reports and plots go under `.cache/loudness` and `.cache/loudness-oracle`.

The software reference checks support confidence in the implemented algorithm. They do not calibrate a microphone, establish an individual's perception, certify ISO compliance, measure an ESP32 processing budget, or establish physical LED color and luminance. Hardware timing, DMA stress, microphone format and gain, electrical current, response curves, and observed flicker still need bench validation before hardware claims.

Sources:

- [ISO 532-1 supplementary programs and reference signals](https://standards.iso.org/iso/532/-1/ed-1/en/)
- [MoSQITo time-varying loudness implementation](https://github.com/Eomys/MoSQITo/tree/v1.2.1/mosqito/sq_metrics/loudness/loudness_zwtv)
- [Resampler 0.5.1 streaming API and filter design](https://docs.rs/resampler/0.5.1/resampler/)
- [HSLuv reference mathematics](https://www.hsluv.org/math/) and [reference snapshots](https://github.com/hsluv/hsluv/tree/master/snapshots)
- [Web Audio specification](https://www.w3.org/TR/webaudio/)

MoSQITo-derived tables and algorithm attribution appear in `THIRD_PARTY_NOTICES.md`.

The reference target also builds the pinned independent [deeuu/loudness oracle](https://github.com/deeuu/loudness/tree/82de790f79c5b358040861e8bdb906a55009b117) and compares source-band spectral, excitation, partial-loudness and temporal stages. See `validation/partial`.
