# Audio, loudness, and light

The live browser, terminal, and ESP-IDF application use one ISO 532-1:2017 time-varying Zwicker implementation. The measurement stage returns total loudness in sones and 240 specific-loudness values in sones/Bark. A separate display stage turns those values into light activity. Adaptive display gain never changes the measured values.

A 20 ms RMS window is not sufficient for every frequency. It covers one cycle at 50 Hz and less than half a cycle at 20 Hz. The model instead uses the specified third-octave filters and frequency-dependent power integration, followed by the specified temporal loudness stages. Its output interval is 2 ms; that interval is not its integration duration.

## Measurement contract

- Input is mono PCM at exactly 48,000 samples/second. Signed 16-bit PCM uses division by 32768. Float PCM above nominal full scale remains intact; a counter reports samples with absolute value at least one.
- Calibration supplies pascals per PCM unit. Without a measurement, the explicit assumption is **2 Pa per unit**: an RMS input of one represents 100 dB SPL. The user interface labels this state **Uncalibrated**. Its sones are conditional on that assumption, not measured environmental loudness.
- The default field is free field. Diffuse field supports the corresponding reference case. This is a monaural model, not a binaural or hearing-loss model.
- Twenty-eight third-octave channels use f64 filter states and power. Their three power low-pass stages use `tau = 2 / (3 * min(center_hz, 1000))`. Core loudness, nonlinear decay, upward masking slopes, and final temporal weighting follow the reference method.
- Every frame has an input sample index. The frame grid starts at the supplied first sample and advances by 96 samples. Two interpolation stages require 48 samples of lookahead. `finish()` emits any final frame on the input grid; it does not append an artificial silence tail.
- Callback size never defines a measurement window. Empty or non-finite blocks fail before model updates. Missing samples require an explicit reset. Out-of-domain levels stop analysis instead of returning plausible looking numbers. The reference algorithm limits its low-frequency correction to 120 dB SPL.
- Every ten adjacent specific-loudness bins form one 1-Bark display band. The panel sums the first five band integrals before display compression, then retains the other nineteen bands. Specific loudness is the model's spectral output; the time-weighted total is not recomputed from the visual bars.

## Input and calibration

The browser builds its full graph while the context is suspended, then starts the audio clock. It requests a 48 kHz AudioContext and disables automatic gain, echo cancellation, and noise suppression. It checks actual track settings. Unknown or enabled processing keeps the input uncalibrated. A selected input channel supplies the signal; opposite-phase channels cannot cancel through downmixing. Web Audio converts the track's native rate to the analysis context rate.

Open **Input calibration**, choose the input channel before capture, and supply the known steady reference level in dB SPL. Keep microphone placement and input gain fixed. The measurement uses exactly three seconds of RMS input. Silence, clipping, and invalid levels fail. The scale is `20e-6 * 10^(reference_dB/20) / measured_RMS`. The browser applies it at an exact sample boundary and binds a saved profile to the device, channel, context rate, and complete reported track settings. A changed track setting, mute, ended track, or processor failure stops the session. The browser cannot detect a physical gain change that the device does not report; repeat calibration after such a change. Blocked local storage permits calibration for the current session only.

The terminal requests 48 kHz and uses the default channel numbered 1. Other supported rates of at least 44.1 kHz pass through the pinned 128-tap, 90 dB `resampler` FIR. The stream retains history across callbacks. Sixty-three zero prehistory samples align the upstream FIR center; its remaining 1/1024-input-sample phase precision is at most 23 ns at 44.1 kHz. Tests bound the resulting callback-dependent PCM roundoff at 0.0001 for a 1 kHz, amplitude-0.5 tone. The loudness model itself gives bit-identical frames for the same PCM stream under all tested partitions. Native clipping checks include both integer rails. Capture timestamps and driver errors detect gaps. CPAL cannot query hardware gain or processing, so measured profiles require an operator-supplied fixed-settings description and an exact device/channel/rate/format match.

From `musical-terminal`:

```sh
cargo run --release --locked -- --channel 1
cargo run --release --locked -- --channel 1 --reference 94 --save reference.json --settings 'Device gain 40%; audio processing off'
cargo run --release --locked -- --channel 1 --profile reference.json --settings 'Device gain 40%; audio processing off'
```

The ESP32 uses 48 kHz, Philips mono left-channel, signed 16-bit input on BCLK 26, WS 33, DIN 25. The application owns the ESP-IDF receive channel directly so its interrupt callback can report DMA overflow. A read error or overflow stops the measurement and clears the panel. The input must match the microphone's actual wire format; confirm it on hardware before treating it as a measurement.

## Display contract

One slow gain follows the strongest of the 24 bands. Its target maps that band to 80% activity. Gain stays between 1/64 and 64, changes downward with a 2 s time constant and upward with a 20 s time constant, and freezes below 0.1 total sone. Each display value is `x / (1 + x)`. These values are **artistic activity**, not loudness units. A steady tone remains visible; the gain does not learn it as noise.

The producer consumes every loudness frame and updates a complete motion snapshot. Peaks rise immediately, hold for 350 ms, and then follow a critically damped fall at 6/s. White edges fade at 10/s after the hold. Reduced Motion uses 3/s and 5/s. A value within 0.0001 of its target settles exactly. The renderer samples that snapshot using audio time. Tests cover 30, 60, 120, 144, and 240 Hz, delayed drawing, steady levels, short taps, and combined bar/edge luminance reversals. These tests do not establish universal photosensitivity safety for all content and devices.

The browser runs analysis in its own AudioWorklet WASM instance. It preallocates its input and state buffers and imports no browser functions into WASM. At most one display message waits for acknowledgement; audio processing continues while the page stalls. Native and ESP capture process audio before the latest visual-state handoff. Neither live path queues raw audio for a slower renderer.

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
