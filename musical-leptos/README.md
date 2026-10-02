# Leptos musical lights

This application uses Leptos 0.9.0-beta in CSR mode and the shared Bark processor.
It renders 24 loudness bands across the 24-Bark scale. Each visible bar also
drives its collision surface. The audio context requests 48 kHz; processing
follows its actual block lengths.
Stop listening or leave the view to release the microphone.

Use Rust `nightly-2026-09-10`, Trunk `0.22.0-beta.5`, and wasm-bindgen `0.2.128`.
Install the pinned CLIs with `python3 validation/install_tools.py web` from the
repository root and add `.tools/bin` to `PATH`.

```sh
trunk serve --port 3000
trunk build --release --locked
```

The release output is `dist/`. Microphone access needs HTTPS or localhost.
The post-build hook publishes the built entry document at `about/index.html`
and `advanced/index.html`, plus `404.html`. GitHub Pages serves About and
Advanced with HTTP 200, including direct visits and refreshes. `/phone` follows
the normal not-found path; there is no compatibility redirect. Unknown paths
start the same Leptos router through Pages' custom 404 document and retain
HTTP 404. The generated `<base href="/">` keeps scripts, styles, and WASM at the
site root when a nested URL loads. No client redirect or URL encoding is needed.
Add each new non-root page route to `publish_routes.py` when adding it to `App`.
The browser test server uses static files and the emitted 404 document, so a
missing route entry cannot silently pass as HTTP 200. The Pages workflow deploys
this output after all validation jobs pass.

The controls and graph appear directly below navigation. Descriptive text follows
the app. The vertical labels read Quiet/Loud. Hover, keyboard focus, or touch
reveals an approximate frequency label.
Hz labels use the established integer-Bark endpoints. Touch readouts
keep the existing three-second timeout and gesture handling.

Eight rigid balls move among the bars using the shared rigid-body physics worker
and WebGL renderer. Their surfaces, bar targets and enclosure dimensions match
the collision geometry. Audio attack strokes, gravity release, shaking, tilting
and mouse forces follow [the physics contract](../docs/physics.md).

Listening and Phone motion are separate native switches. Each requests only its
own access. Motion can run with the microphone off, including tilt-only sessions.
Turning either off preserves the other; route cleanup closes both. When Listening
is off, a silent sine signal runs through the production DSP and renderer without
an AudioContext or microphone request.

Each sphere starts with the graph's rainbow color at its horizontal center.
Its initial position selects the color once. A new impact with a bar blends
its current color toward that bar's fixed color, including when a falling
sphere bounces off a stationary bar.
Stronger impacts produce a larger change, limited to a 50% blend per impact.
The blend uses linear sRGB and `screen_color` encodes the result once for CSS.
Sphere-to-sphere collisions, resting contact, and nearby bars do not change the
color. The sphere retains its color until a later bar impact, including when
listening stops and starts again.

Stopping Listening clears musical targets and flashes; the silent preview then
resumes. Phone motion stays active until its switch is off or the page closes.
Disabling motion clears sensor forces while audio continues. Route cleanup
cancels animation, terminates workers, closes audio, and removes sensor listeners.
Late permission results cannot reopen a closed motion session.

Fullscreen expands the visualizer, hides settings, and keeps manual Identify song
available with microphone input. Exit fullscreen or Escape returns to the page.
Recovery notices appear above the song overlay.

The visible visualizer requests a [screen wake lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API),
including before microphone access. Its status appears below the lights; FPS is available in Advanced diagnostics.
The lock releases when the tab is hidden or the view closes, and the page requests
a new lock when visible again. Browser or power settings can reject or release
it; the status then reads “Screen may sleep.” This does not change system sleep
settings or keep a hidden tab awake. Pending requests also release after closure.

The page follows the system's light or dark color scheme, including changes while
it is open. CSS applies the theme before the Rust application starts. Text,
surfaces, controls, and tooltips adapt together. Each bar keeps
one fixed rainbow color from the shared `Gradient::new_rainbow`: red bass, then orange, yellow,
green, blue, and purple treble. The baseline uses the same color as its bar.
The gradient uses 90% saturation and 58% perceptual lightness. Its linear sRGB
channels pass through `screen_color` once and use CSS `color(srgb …)`. Colors
do not change with volume or the system theme.

The 24 accessible groups each contain one accessible meter. Bars have narrow
gaps and circular top corners with a radius of one quarter of the bar width.
A 1-pixel white inner border follows all four edges, including the rounded top
and baseline. It fades with the existing attack envelope. The center keeps its
color even at peak glow. One Tab stop remembers the last focused bar.
Left/Right moves one bar; Home/End selects the endpoints. Tab exits to Scroll lights on Home (Display on Advanced); Shift+Tab returns to Fullscreen.

The model still calculates 240 specific-loudness values internally. It integrates
each set of ten values into one Bark band, then applies one shared adaptive gain
and proportional common-headroom scaling. Browser bars, sphere collisions, terminal,
and LEDs use that same band activity. The grid and LOUD label cover the fill
area; the 5% headroom sits above that scale.

One transferable snapshot contains 99 f64 values (792 payload bytes): audio
time, Reduced Motion, total sones, and four target and edge values for each of 24 bands. The decoder
rejects malformed data and closes that audio session. One snapshot can wait for
acknowledgement; analysis continues while the UI is delayed, and the next
acknowledgement releases current state without a backlog.

Each loudness frame supplies the current gain-scaled target, without a height hold or decorative release. White edges retain independent acoustic attack timing. Physical bars use 40 ms attack strokes and approximately 1.13 s full-height gravity release (320 ms with Reduced Motion); rendering follows the collider snapshots. See [the display contract](../docs/loudness.md) and [physics timing](../docs/physics.md).

Audio analysis runs at the full input rate. The renderer keeps drawing when
Listening stops and cancels its callback on page exit. Advanced provides private
local-file playback, two attributed audit excerpts, test tones, pause/resume,
replay, repeat and listening-note exports. Digital sources use the same worklet
and preserve the selected channel PCM; they request no microphone permission.

The shared loudness model runs at 48 kHz and emits a complete loudness frame every
96 samples (2 ms). A worklet callback can complete zero, one, or several frames.
It consumes each frame to preserve attacks, then transfers the latest full motion
state when the UI has acknowledged the previous packet. Audio callbacks do not
set the screen frame rate. Silence still advances the model and motion state.

The Advanced diagnostics FPS counter measures that animation callback over at least one second. It
includes delayed frames and does not count audio callbacks or depend on bar
movement. It shows “— FPS” when drawing stops. The browser controls
[animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame);
the page does not assume or force 120 FPS. The counter measures callback delivery,
not physical monitor refresh or GPU presentation.

White-edge timing does not limit height changes. The previous combined bar/edge flash-rate guarantee depended on a height hold that is now removed. The `/advanced` page provides stationary tones, all-band steps, sweeps, two tones, volume changes, bursts, and silence for visual review, with optional audible playback and bounded diagnostic traces.

Floating-point PCM can exceed its nominal [-1, 1] range, as specified by the
[Web Audio standard](https://www.w3.org/TR/webaudio/#AudioBuffer). The processor
accepts finite peaks without clipping. A disconnected or missing selected channel stops the session. Digital playback
preserves the selected channel without averaging or fitted gain.

See [validation](../docs/validation.md) for routes, microphone, worklet, layout,
contrast, reduced motion, and display timing checks. The temporary interaction counter
has been removed.

Share metadata lives in `index.html`, so preview services can read it without
JavaScript. Trunk copies `public/social-preview.png` to the site root. The PNG
is 1200×630 and uses the shared rainbow palette. Open Graph and Twitter image
cards point to its public HTTPS URL. The app does not inject duplicate metadata.

To regenerate the image, build the Leptos application, then run the following
from `validation/` with the pinned Node and browser tools installed:

```sh
npm run preview
```

The renderer reads the actual app colors, draws a static illustration, and saves
the PNG. Rebuild Leptos after regeneration to copy the updated image into `dist/`.
Preview services can cache existing cards; check the sharing app after deployment.
