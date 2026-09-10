# Audio and LED processing

The active ESP-IDF application uses `BarkBank` from `musical-lights-core`.
It reads normalized mono PCM through I2S at 44,100 Hz.

1. Validate the full input block before changing processor state.
2. Filter each sample through 24 Bark bands. Each band has two biquad stages.
   Each stage has unity gain at its center frequency. The original edges and
   bandwidth multiplier of three remain in use.
3. Compute block RMS, apply the retained empirical frequency weight, and raise
   the result to the power 0.23.
4. Update each peak and floor envelope using the actual block duration.
   The peak uses 22 ms attack and 10 s release. The floor rises over 10 s and
   falls immediately.
5. Sum the first five band values, floors, and peaks into one bass value. Keep
   the remaining 19 bands separate. Normalize to the adaptive range, with the
   retained peak floor of twice the tracked minimum. Clamp the result to [0, 1].
6. Return zero for silence or a zero normalization range.
7. Map the 20 display values to the existing brightness range, 8 through 128.
   Keep each LED envelope as a float until the final brightness conversion.
   Preserve the panel mapping, palette, scrolling, and onboard brightness limit.

These stages form an artistic visualizer. They approximate loudness; they do
not implement ISO 226, ISO 532, or another calibrated loudness model.

Invalid sample rates, empty input, non-finite samples, and samples outside
normalized PCM range return typed errors. Filters also reject rates whose
coefficients cannot form a finite, stable filter in f32.

The LED thread creates and owns its RMT drivers. The current driver does not
support moving an initialized encoder between threads. Sensor UART and several
orientation-based patterns remain compiled but inactive, as in the prior
application. They are not part of the tested physical audio path.
