# Leptos musical lights

This application uses Leptos 0.9.0-beta in CSR mode and the shared Bark processor.
It renders all 24 analysis bands separately. It uses the browser's actual sample
rate and block lengths. Stop listening or leave the view to release the microphone.

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
the app. The vertical labels read Quiet/Loud. Hover or focus a band to see its
exact frequency edges.

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
surfaces, controls, and tooltips adapt together. Each meter keeps a fixed rainbow
color from the shared `Gradient::new_rainbow`: red bass, then orange, yellow,
green, blue, and purple treble. The baseline uses the same color as its bar.
The gradient uses 90% saturation and 58% perceptual lightness. Its linear sRGB
channels go directly into CSS `color(srgb-linear …)` so the browser applies the
correct display encoding. Colors do not change with volume or the system theme.

Each bar gains a white border and a small glow on a new display peak. The border
uses the same 350 ms peak hold as the bar, then fades exponentially. It loses
90% of its brightness in 0.23 seconds after the hold, ahead of the colored trail.
Reduced Motion doubles that fade duration. Steady levels do not retrigger it.
The border follows the bar's actual height with a constant one-pixel outline,
including in fullscreen. This adapts the white accents in Bryan's hat video to
the web bars; it does not add a separate row of lights.

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

The shared processor integrates filtered power over 20 ms windows: 882 samples
at 44.1 kHz or 960 at 48 kHz. Compression and adaptive normalization update only
after a complete window. A callback can complete zero, one, or several windows;
the display receives the latest complete result. Partial windows retain that
result. A fully silent window produces zero, while filters and envelopes still
advance. Analysis can add up to one window of delay before the display receives
a new level.

The FPS counter measures that animation callback over at least one second. It
includes delayed frames and does not count audio callbacks or depend on bar
movement. It shows “— FPS” when drawing stops. The browser controls
[animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame);
the page does not assume or force 120 FPS. The counter measures callback delivery,
not physical monitor refresh or GPU presentation.

The visibility hold uses the [WCAG 2.2 flashing criterion](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes.html)
as its design limit: a newly lit height stays lit long enough to prevent more
than three repeated flash cycles in any second. The white border shares that
hold and only brightens with a new bar peak, so it has no independent flash
clock. Tests also examine luminance changes as its top edge passes a colored
pixel. These checks do not provide a medical safety guarantee. The rainbow
colors and page background stay fixed while the border fades.

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
