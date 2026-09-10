# Repository upgrade plan

Stay on `main`. Use the newest releases and pre-releases, with immutable upstream revisions where the current published crates do not support this stack. Freeze the selected versions during validation. Keep the shared 24-band Bark processor. The website and terminal show 24 separate bands. The 20×20 panel retains 20 rows, with the five bass bands combined before normalization, as Bryan clarified.

## Completed implementation and checks

- Preserve all eight existing changed files in checkpoint commit `b8db361` before repairs.
- Update all nine packages, each independent lockfile, and the Dioxus lockfile.
- Migrate the web, ARM, ESP Embassy, and ESP-IDF APIs. Retain the existing implemented peripheral tasks.
- Repair filter gain, audio input validation, sample-based envelope timing, shared audio output, fractional LED decay, frame writes, and message bounds.
- Pass the complete validation command for all nine packages and eight browser tests. Repeat affected checks after final review changes.
- Update build instructions and CI coverage. Validate workflow syntax with actionlint 1.7.12.

## Added checks from Bryan

- Verify every active Rust toolchain file, build command, override, and CI pin uses the latest dated nightly where nightly is intended. The official nightly manifest confirms `nightly-2026-09-10`. Non-ESP packages use that date. Both ESP packages use the separately installed `esp-1.98.1.0` Xtensa compiler. `rustup override list` reports no overrides.
- Review LED timing against the actual parts. Do not assume that either the old pulses or a new preset are correct merely because a driver supplies them. Identify the onboard LED and external panels, compare datasheet limits and driver output, select the supported timing, then keep physical signal checks open until hardware is available. The [completed source review](led-timing.md) selects the current WS2812B preset; physical checks remain pending.

## Delivery

The base upgrade was committed as `6802973` and pushed on `main`. Both GitHub workflows passed. The canonical remote is now `git@github.com:BlinkyStitt/musical-lights-rs.git`.

## Completed microphone and page repairs

- Remove the incorrect rejection of finite microphone peaks outside the nominal PCM range. Preserve signal levels without clipping. Keep whole-block rejection of empty or non-finite input before state changes, and keep filtering finite even at extreme input magnitudes.
- Check channel mixing, absent input, error recovery, actual sample rates and block lengths, and audio cleanup. Advance the processor through silent input gaps.
- Replace the text bars and multi-column layout with 24 persistent meters in a centered, responsive page. Use readable controls, stable colors, frequency labels, and a clear microphone state. Keep all five bass bands separate on the website. Preserve the LED panel's 20 rows of 20 pixels, palette, scrolling, and wiring order; do not distribute bands across 16/17-pixel segments.
- Remove the temporary interaction counter and its tests, as requested by Bryan. The counter is not part of the page design.
- Reduce visual flicker using WCAG 2.2 flashing criteria: limit automatic meter target changes to two per second, interpolate smoothly without overshoot, and respect reduced motion. Keep analysis at the full audio rate. Test rapid alternating signals and delayed message delivery. Do not claim a medical safety guarantee.
- Check real browser audio peaks, silence, denial, cleanup, stable DOM nodes, phone and desktop centering, reduced motion, and display timing. Recheck all packages because the shared processor changes; record CPU and memory costs.
- The complete all-root validation passed with 31 core tests in four feature combinations, three terminal tests, two display timing tests, 12 browser tests, and all release builds. The panel retains 20 complete rows. Physical hardware checks remain separate.

## Final delivery

Review the complete diff, commit and push the repairs on `main`, then verify CI, remote alignment, and a clean tree.
