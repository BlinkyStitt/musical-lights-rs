# Repository upgrade plan

Stay on `main`. Use the newest releases and pre-releases, with immutable upstream revisions where the current published crates do not support this stack. Freeze the selected versions during validation. Keep the shared 24-band Bark processor and its 20 display outputs.

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

Finish the complete diff review, record validation evidence and hardware limits, commit the coherent repairs, push `main`, and verify a clean tree and exact remote alignment.
