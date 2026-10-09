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

- Keep common controls grouped, Listening beside Identify song, visible focus,
  native switches and 44-pixel touch targets. Use hover/focus help and a mobile
  tap popup. Keep less common settings collapsed below the scene.
- Mobile opens in the expanded video/visualizer/bottom-controls layout without
  starting audio or requesting native fullscreen. Normal pages use the same
  video/scene/bottom-controls order, with extra settings and learning below.
  Keep Exit usable in short
  landscape screens, with safe areas, recognition and recovery notices.
  Float the video entry over the scene. Keep scene and collider size stable
  while the on-screen keyboard opens; fit the entry to the visible viewport.
  Restore layout sizing and dismiss the keyboard on Load, Remove and Exit.
- Matching bars grow inward from both ends and reserve space for the balls.
  Omit Quiet/Loud labels. Keep a single accessible meter per source band
  despite background banks and depth drawing.
- Draw a direction probability only after a new attack exceeds the recent
  loudness peak. Defaults rise from 5% at 60 BPM to 50% at 200 BPM. Advanced
  settings expose the endpoint tempos, probabilities and curve. Preserve
  seeded replay and reject invalid settings; do not reverse on a fixed timer.
- Mirrors must be transparent from outside the box. Bound reflection cost and
  measure it; prefer instancing and avoid recursive reflection cameras, shadow
  maps and bloom for this phone-oriented view. Reduced Motion disables
  automatic scrolling, camera motion and additional pigment drift.
- Mirror count controls drawing only; six depth images are the default, and
  saved choices remain unchanged. Advanced allows 0–2048 images; validate the
  upper bound and saved settings without changing physical ball counts. Four
  full-size background boxes flank the
  physical center box and reuse all source bands in matching vertical banks.
  Center posts span the collider depth.
  Ball depth images are fading translated copies, not optical reflections.
  Bars extend as continuous geometry with a smooth depth fade; do not restore
  per-copy end faces or brightness steps. Cull background bars against their
  full extruded bounds and verify visible pixels before claiming savings.
  Do not add
  simulated balls for background boxes or depth images. Keep all bands responsive
  with the configured rise duration; measure packet-to-render delay as well as steps.
  Hide BPM when audio stops; silence eases to
  the shared core's 60 BPM fallback without changing loudness or filtered targets.
- Show one scrolling artist/song title in expanded mode. Keep the progress
  ring and errors beside Identify song. Show rendered FPS beside the angle slider
  in expanded mode; normal Home omits FPS. Camera motion uses a smooth horizontal
  sweep without attack shake or vertical wobble. Do not draw box-frame outlines
  or black bar borders. Retain white attack edges. Repeat source lighting across
  the five banks and depth copies, with one outer coating and no internal walls.
  Normal-page scenes use equal gutters and a responsive 320–560 pixel height.
  The default sweep spans −10° to +10° over a 48-second cycle.
- Listening adds a core-owned travelling floor of at most one sixth of bar
  travel. Keep measured loudness, filtered targets, accessible audio meters and
  attack eligibility separate. Disable this floor under Reduced Motion and
  when the microphone session stops or is interrupted. Record the combined
  visual inputs so physics replay reproduces the wave.
- Prefill the YouTube field with the default video. Load only on an explicit
  Load video action. Clearing the field preserves the playing video and saves
  the empty preference; Remove video stops the player.

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
