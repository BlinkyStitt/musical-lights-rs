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

The page follows the system's light or dark color scheme, including changes while
it is open. CSS applies the theme before the Rust application starts. Text,
surfaces, controls, and tooltips adapt together; the meters retain their blue hue.

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

The FPS counter measures that animation callback over at least one second. It
includes delayed frames and does not count audio callbacks or depend on bar
movement. It shows “— FPS” when drawing stops. The browser controls
[animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame);
the page does not assume or force 120 FPS. The counter measures callback delivery,
not physical monitor refresh or GPU presentation.

The visibility hold uses the [WCAG 2.2 flashing criterion](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes.html)
as its design limit: a newly lit height stays lit long enough to prevent more
than three repeated flash cycles in any second. It does not provide a medical safety guarantee. The page
contains no automatic hue, opacity, or background animations.

Floating-point PCM can exceed its nominal [-1, 1] range, as specified by the
[Web Audio standard](https://www.w3.org/TR/webaudio/#AudioBuffer). The processor
accepts finite peaks without clipping. Missing input produces silent blocks
that still advance filter state. Channel mixing rounds only after averaging.

See [validation](../docs/validation.md) for routes, microphone, worklet, layout,
contrast, reduced motion, and display timing checks. The temporary interaction counter
has been removed.
