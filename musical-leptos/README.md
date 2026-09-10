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

Meters reach new peaks on the next screen frame. They retain short taps between
frames, hold each new peak for 350 ms, then fall with increasing speed. A full-height
fall takes about 0.63 seconds after the hold. Each bar stops at its current live
band level; that level remains valid between audio callbacks. Audio analysis runs
at the full input rate. One reusable animation callback draws the existing nodes
and is cancelled when listening stops or the view closes, including pending
microphone permission. Reduced motion removes the falling animation but keeps
the same visibility hold. There is no separate pause/resume state.

The visibility hold uses the [WCAG 2.2 flashing criterion](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes.html)
as its design limit: a newly lit height stays lit long enough to prevent more
than three repeated flash cycles in any second. It does not provide a medical safety guarantee. The page
contains no automatic hue, opacity, or background animations.

Floating-point PCM can exceed its nominal [-1, 1] range, as specified by the
[Web Audio standard](https://www.w3.org/TR/webaudio/#AudioBuffer). The processor
accepts finite peaks without clipping. Missing input produces silent blocks
that still advance filter state. Channel mixing rounds only after averaging.

See [validation](../docs/validation.md) for routes, microphone, worklet, layout,
contrast, reduced motion, and display timing checks. The temporary counter
has been removed.
