# Audio and LED processing

The active application uses the shared `LoudnessMeter`, `VisualGain`, and `DisplaySnapshot`. See the [measurement and display contracts](../docs/loudness.md) for units, timing, calibration, validation and limits.

`capture.rs` owns a 48 kHz ESP-IDF receive channel and the I2S/pin tokens. It uses the existing Philips mono left-channel format and pins. A sticky interrupt flag reports DMA overflow. Blocking reads have a timeout. Any capture/model error ends analysis; the LED thread clears the panel.

The microphone thread processes every sample and loudness frame before it publishes a complete latest visual state. The LED thread copies that state under a short mutex and advances motion using audio elapsed time. Rendering cannot discard unprocessed audio or reset peak timing.

The panel has twenty rows of twenty pixels. Five low Bark bands form one bass row, and nineteen higher bands each have one row. The wedding palette stays in linear RGB until the measured LED response or explicit unmeasured default maps it to bytes. Ambient light intent stays at 8/255 and the drive cap stays at 128. Row scrolling uses elapsed time at the previous rate.

`light_profile.rs` is the single deployment calibration profile. Generate it from measurements with `validation/lights/profile.py`. `light-check` is a separate bench program for channel order, ramps and timed pulses. Neither program claims measured color until a profile has been measured and validated.

Each LED thread creates and owns its RMT driver. Sensor UART and orientation patterns remain inactive. The software checks compile both firmware binaries; they do not flash a board or validate its processing headroom.
