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
Configure static hosting to return `index.html` for application routes.
The current Pages workflow preserves the site's root URL.

The controls and graph appear directly below navigation. Descriptive text follows
the app. The vertical labels read Quiet/Loud. Hover, keyboard focus, or touch
reveals an approximate frequency label.
Hz labels use the established integer-Bark endpoints. Touch readouts
keep the existing three-second timeout and gesture handling.

Twenty-four decorative spheres sit above the bars. Their diameters range from 0.55 to
four bar widths. Motion starts when the graph appears and continues with the
microphone off. Steady gravity pulls them toward the bottom of the page, even
when a phone lies flat on its back. They accelerate as they fall and bounce off
each other, bars, and graph edges. Rounded bar corners send corner hits sideways.
Move a mouse near a sphere to repel it.
Device tilt supplies a small wind force, and a shake supplies a short impulse.
Gravity stays in page coordinates and is stronger than the tilt wind. Touch
gestures still control the graph and fullscreen view.

The Start listening click also requests device motion permission where required.
If that request fails, is denied, or the sensor API is unavailable, mouse input
continues to work. Shake input uses acceleration without gravity; devices that
cannot provide it still support tilt when available. No sensor input is required
to use the microphone.

Each sphere starts with the graph's rainbow color at its horizontal center.
Its initial position selects the color once. A new impact with a bar blends
its current color toward that bar's fixed color, including when a falling
sphere bounces off a stationary bar.
Stronger impacts produce a larger change, limited to a 50% blend per impact.
The blend uses linear sRGB and `screen_color` encodes the result once for CSS.
Sphere-to-sphere collisions, resting contact, and nearby bars do not change the
color. The sphere retains its color until a later bar impact, including when
listening stops and starts again.

Gravity is 4.8 graph heights/s² normally and 2.4 with Reduced Motion.
A sphere released in free space falls at least half a graph height in half a
second normally, or one tenth with Reduced Motion. Speed is capped at 3.2 graph
units/s. Reduced Motion disables shake impulses and reduces mouse forces and
bar impulses. It applies stronger damping and softer bounces. Gravity still
points down the page. Collision correction keeps the bodies outside the bars.
The graph reserves room above fully raised bars, including in fullscreen.
Spheres do not block pointer input or appear in the accessibility tree.

Sphere physics writes directly to the existing decorative nodes on animation
frames. Stop listening, microphone permission failure, and audio failure clear
the bar levels and remove sensor listeners. Gravity, momentum, sphere collisions,
and mouse input continue. Route cleanup cancels the pending frame and removes
all input listeners. Late motion permission results cannot restore sensors for
a closed audio session. Sensor permission denial leaves gravity and mouse input
active.

Fullscreen expands the visualizer and keeps the microphone controls available.
Use Exit fullscreen or the browser's fullscreen exit to return to the page.
The button follows actual browser state and reports rejected requests.

The visible visualizer requests a [screen wake lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API),
including before microphone access. Its status appears beside the FPS counter.
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
Left/Right moves one bar; Home/End selects the endpoints. Tab exits to Input
calibration and Shift+Tab returns to Fullscreen.

The model still calculates 240 specific-loudness values internally. It integrates
each set of ten values into one Bark band, then applies one shared adaptive gain
and the existing 24-band motion model. Browser bars, sphere collisions, terminal,
and LEDs use that same band activity. The grid and LOUD label cover the fill
area; sphere headroom sits above that scale.

One transferable snapshot contains 146 f64 values (1,168 payload bytes): audio
time, Reduced Motion, and six motion values for each of 24 bands. The decoder
rejects malformed data and closes that audio session. One snapshot can wait for
acknowledgement; analysis continues while the UI is delayed, and the next
acknowledgement releases current state without a backlog.

Meters reach new peaks on the next screen frame. They retain short taps between
frames and hold each new peak for 350 ms. A critically damped fall then starts
gently and slows as it approaches the current live band level. It covers 90% of
a fixed downward distance in about 0.65 seconds after the hold. Reduced Motion
halves the release speed instead of dropping in one step. Each bar stays above
its live level, including when that level changes between frames. A remainder
below 0.0001 of full height (under 0.04 pixels) settles to the exact level.

Audio analysis runs at the full input rate. One reusable animation callback draws
the existing nodes and is cancelled when listening stops or the view closes,
including pending microphone permission. There is no separate pause/resume state.

The shared loudness model runs at 48 kHz and emits a complete loudness frame every
96 samples (2 ms). A worklet callback can complete zero, one, or several frames.
It consumes each frame to preserve attacks, then transfers the latest full motion
state when the UI has acknowledged the previous packet. Audio callbacks do not
set the screen frame rate. Silence still advances the model and motion state.

The FPS counter measures that animation callback over at least one second. It
includes delayed frames and does not count audio callbacks or depend on bar
movement. It shows “— FPS” when drawing stops. The browser controls
[animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame);
the page does not assume or force 120 FPS. The counter measures callback delivery,
not physical monitor refresh or GPU presentation.

The visibility hold uses the [WCAG 2.2 flashing criterion](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes.html)
as its design limit: a newly lit height stays lit long enough to prevent more
than three repeated flash cycles in any second. The white glow shares that
hold and only brightens with a new bar peak, so it has no independent flash
clock. The inner border fades with its acoustic attack envelope.
These checks do not provide a medical safety guarantee. The rainbow
colors and page background stay fixed while the glow fades.

Floating-point PCM can exceed its nominal [-1, 1] range, as specified by the
[Web Audio standard](https://www.w3.org/TR/webaudio/#AudioBuffer). The processor
accepts finite peaks without clipping. Missing input produces silent blocks
that still advance filter state. Channel mixing rounds only after averaging.

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
