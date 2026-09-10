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
- Reduce visual flicker using WCAG 2.2 flashing criteria. The first version limited target changes to two per second. Bryan requested a faster attack; the display response update below replaces that pacing. Keep analysis at the full audio rate and respect reduced motion. Test rapid alternating signals and delayed message delivery. Do not claim a medical safety guarantee.
- Check real browser audio peaks, silence, denial, cleanup, stable DOM nodes, phone and desktop centering, reduced motion, and display timing. Recheck all packages because the shared processor changes; record CPU and memory costs.
- The complete all-root validation passed with 31 core tests in four feature combinations, three terminal tests, two display timing tests, 12 browser tests, and all release builds. The panel retains 20 complete rows. Physical hardware checks remain separate.

## Final delivery

Review the complete diff, commit and push the repairs on `main`, then verify CI, remote alignment, and a clean tree.

## Completed display response update

- Replace the two-updates-per-second display with immediate rises on the next screen frame and a gradual, gravity-like fall. Retain the flashing constraint and verify repeated taps, frame timing, and resource cleanup.
- Stop each falling bar at its current live band level. Keep that level between audio callbacks, and test that gravity cannot pull a bar below it.
- Remove the pause/resume buttons and their state and handlers.
- Remove the “Every band has room” content. Show exact frequency edges when the pointer rests on a band, using the shared filter definitions.
- Rename the vertical labels from Low/High to Quiet/Loud.
- Put the microphone controls and complete graph directly below navigation. Move descriptive text below the app and reduce empty space. Check that phone and desktop users can see the graph without scrolling.
- Keep the microphone repair, all 24 web bands, the panel's 20 rows of 20 pixels, the completed package/toolchain updates, and the canonical remote. Validate the changed page, commit, push, and check deployment again.

Six display tests, native/WASM Clippy, the Trunk release build, and all 12 browser tests passed. Browser checks cover all frequency tooltips, the live-level floor, next-frame attack, continuous fall, repeated flashes, and animation cleanup. At 375/768/1440 pixels the graph appears above the description and fits in the first viewport. Commit `d9a71ef` delivered this update. All-package CI, Pages deployment, and live-site checks passed.

## System color scheme

Follow the user's system light/dark setting on initial load and when it changes. Apply one CSS theme to the complete page, retain the blue meters, and verify text and graph contrast at phone, tablet, and desktop widths.

The Leptos checks and release build passed. All 15 browser tests passed, including both themes at all three widths, contrast, live setting changes, and color-vision simulations.

## Smoother falls and a frame-rate counter

Replace the hard gravity landing and the single-step Reduced Motion drop with a
damped fall that slows before reaching the live level. Keep immediate rises,
the live-level floor, and the 350 ms flashing guard. Measure the old and new
rendered motion with the same audio input and browser frame timing.

Add a visible FPS counter based on actual animation callbacks and elapsed time.
Update its text once per second, include stalled frames, and reset it when drawing
stops. Verify 30/60/120/144/240 Hz timing, a rising floor during descent, both
motion preferences, and browser agreement between the counter and frame timestamps.

Eight display tests, native/WASM Clippy, the Trunk build, and all 15 browser tests passed. At the same measured 60 FPS, the controlled tap fell at most 6.40 pixels per frame after the repair, compared with 12.10 before. Reduced Motion changed from a 174.35-pixel step to at most 3.21 pixels per frame.

## Rainbow frequency colors

Use the existing shared rainbow gradient for all 24 website bars. Start at red
for bass and pass through orange, yellow, green, and blue to purple at the highest
band. Correct the gradient's hue range: HSLuv uses degrees, and its former
255-degree endpoint stopped at blue. Keep colors fixed while audio changes height.
Use the same color for each bar and its baseline. Check every color's contrast
in both system themes, all frequency tooltips, and the existing motion and FPS
behavior. Keep the LED panel's existing palette and 20-row geometry.

The core feature checks passed with 32 tests in each of four combinations. The
Leptos checks, release build, and all 15 browser tests passed. Every bar has at
least 3:1 contrast against the graph in both themes. Noise input checks exercise
all 24 bars, and theme changes and audio updates preserve their colors.

## Active display and sharing requests

- Adapt the white accents in Bryan's supplied hat video to the web bars. Bryan
  requested glowing bar borders instead of separate lights above the graph.
  Keep the rainbow fills and smooth fall. Brighten each border on a new display
  peak, share the existing 350 ms hold, then fade it faster than the colored
  trail. Keep the agreed flashing limit and reduced-motion behavior.
- Keep the screen awake while the visualizer page is visible. Release its wake
  lock when the view closes or becomes hidden, request it again when visible,
  and report when the browser or system does not grant the lock. Do not change
  the computer's global sleep settings.
- Add Fullscreen and Exit fullscreen controls to the visualizer. Fit the graph
  and controls to the screen, follow browser exits such as Escape, and handle
  rejected or late requests without leaks. The screen controls now compile and
  pass the lifecycle and browser checks described below.
- Add an attractive share preview. The former `musical-leptos/index.html` had
  no share metadata. `src/lib.rs` added some metadata after the app started,
  without `og:title`, `og:description`, or `og:image`. Supply complete metadata
  in the initial HTML so preview services do not need to execute JavaScript.
  Move the site-wide tags to that single source instead of duplicating them in
  the client-rendered app.
- Design a 1200×630 PNG preview with a dark background, the shared 24-color
  rainbow spectrum, and a clear Musical Lights title. Keep the main content
  inside a margin so cropped cards remain readable. Publish the image at a
  stable, public HTTPS URL through the existing Trunk and Pages build.
- Add Open Graph title, description, website type, canonical URL, image URL,
  image dimensions, MIME type, and image alternative text. Add a large-image
  Twitter card with matching title, description, and image. Use absolute public
  URLs. Follow the [Open Graph specification](https://ogp.me/).
- Validate the raw built and deployed HTML with JavaScript disabled. Confirm
  that the preview image returns HTTP 200 with the correct type and dimensions.
  Check the actual sharing platform's preview and refresh its cached card where
  supported; do not claim that an existing post updates automatically. Verify
  preview behavior without publishing a test post unless Bryan requests one.

The wake-lock and fullscreen implementation now passes compilation, native/WASM
Clippy, and the Leptos release build. Lifecycle checks cover rejected grants,
system releases, visibility changes during pending requests, view closure, and
late fullscreen entry. A visible Chromium window obtained a real wake lock and
released it on route closure. Desktop and phone fullscreen checks keep the live
graph, controls, and FPS visible in both themes.

The 1200×630 PNG and static metadata are implemented. Browser checks read one
complete set of metadata without JavaScript, fetch the image as a PNG, and check
its dimensions. The renderer uses the actual shared rainbow palette. Deployment
and the sharing platform's cached preview must be checked after merge.

Combined validation passed with 35 core tests in each of four feature
combinations, 11 display tests, 31 browser/lifecycle checks, and the release
build. The separate visible-browser wake-lock check also passed.

Keep all work in the existing audio-repair PR #1, as Bryan requested, including
the 20 ms power-window repair, screen controls, share preview, and white borders.
The supplied 45-second, 24 FPS video shows bright white accents with colored
trails; a frame sequence around 10 seconds shows the accents returning with the
columns. The web effect uses the shared Bark output and existing animation
callback. Checks passed for the border's attack, fade, silence, constant
thickness, modeled luminance changes, and resource cleanup in both themes and
motion preferences. Normal and fullscreen screenshots were inspected.
