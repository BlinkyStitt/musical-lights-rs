# Browser validation

- Run validation commands from the repository root.
- Use the pinned tools in `.tools/bin`. Add that directory to `PATH` before
  running `python3 validation/validate.py leptos` or browser validation.
- Use host access (`sandbox_permissions: "require_escalated"`) for browser
  checks on macOS. Use `python3 validation/validate.py browser` for the full
  browser suite. For a focused check, use
  `.tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.config.mjs`
  with the required test filters.
- Keep the serial startup check in `validation/browser-startup.mjs`. Do not
  bypass it or retry a browser startup failure through more test workers.
- Trusted project rules load when Codex starts. Restart Codex after changes
  to `.codex/config.toml` or `.codex/rules/`. Active session overrides and
  managed restrictions can take precedence. See [validation guidance](docs/validation.md).

# Architecture and preserved contracts

- Put hardware-reusable analysis, tempo, attack eligibility, bar motion,
  direction probability, drag and pigment calculations in `musical-lights-core`.
  Keep them bounded, allocation-free where required, and compatible with the
  existing `no_std`/`libm` feature matrix. Browser APIs, Three.js mirrors and
  Rapier adapters belong in their platform packages. Physical hardware uses
  physical mirrors; do not add mirror rendering to embedded firmware.
- Preserve the production loudness model. Callback sizes must not define
  analysis windows. Keep specific loudness, band aggregation and the shared
  display gain authoritative; do not add fitted gains, per-band normalization,
  shifted audit traces or FFT bars as substitutes for loudness.
- Distinguish raw loudness, filtered targets, physical bar travel, rendered
  geometry and playback timing. Keep the existing fixed-window audit historical;
  read current source and `docs/validation.md` instead of copying old transport
  counts, protocol numbers or acceptance claims from memory.
- The web app shares its Home/Advanced visualizer. Keep `/advanced`, direct
  routes, Home learning content, keyboard/touch meters, calibration, licensed
  attribution, private local-file processing, diagnostics and exports.
  `/phone` receives ordinary not-found handling.
- Listening controls the microphone. Digital playback and phone motion have
  independent lifetimes. Listening remains stoppable during microphone startup;
  closing its context releases audio ownership before a pending acquisition
  returns. Buffering retains YouTube playback routing. Avoid repeated writes
  of an unchanged AudioSession type. Visibility alone must not start input.
  Startup, replacement, visibility changes and route
  cleanup must cancel work before publishing resources from an old session.
  Song identification stays opt-in and microphone-only, with the shared
  cooldown and development upload restriction. Routine tests use mocks;
  invoke the single-request live provider test separately only when authorized.

# Web presentation

Before changing browser layout, controls, animation, or rendering defaults, read
[the presentation contract](docs/presentation-contract.md). Preserve its accessibility,
Reduced Motion, input-lifetime, and replay requirements.

# Validation and delivery evidence

- Read `validation/validate.py` for pinned commands and the feature matrix.
  Verify produced WASM and browser behavior as well as native Rust tests.
  Use the standalone Criterion package in `validation/benchmarks` for production
  audio, tempo and physics CPU comparisons. Run statistical benchmarks on an
  idle host, separately from browser checks; CI runs only correctness smoke cases.
  Identical PCM must retain identical raw loudness and filtered targets.
- Keep one browser worker per runner, zero retries and the serial startup/crash
  guard. CI may distribute the unchanged suite across isolated runners; require
  complete, unique test coverage before publishing a compiled artifact.
- Pages publishes only after the validation barrier. Reuse requires an exact
  source tree and build inputs, a trusted successful producer and verified
  file digests. Keep serialized publishing and the latest-main check. Do not
  deploy a failed validation or create approval gates for the solo developer.
- Report local checks, Linux CI, live provider checks, human listening,
  physical-device tests and production deployment separately. WebKit with an
  iPhone profile is browser evidence, not a physical-iPhone performance result.
  Digital music and diagnostic recording do not establish phone FPS acceptance.
- A queued Pages job or accepted notification does not prove deployment.
  After merge, update local `main` and verify the deployed build identity,
  direct routes and live application behavior. Keep task progress and large
  one-off logs outside Git; use the PR and CI for shared delivery evidence.
