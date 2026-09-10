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

The display collects peaks over each half-second window, then moves the existing
meters to their new heights with a 500 ms linear transition. It uses monotonic
browser time, so delayed audio messages do not replay rapid visual updates.
Reduced motion disables interpolation while retaining the same update limit.
Pause display freezes meter targets while audio analysis continues.

This conservative rate uses the [WCAG 2.2 flashing criterion](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes.html)
as its design limit. It does not provide a medical safety guarantee. The page
contains no automatic hue, opacity, or background animations.

Floating-point PCM can exceed its nominal [-1, 1] range, as specified by the
[Web Audio standard](https://www.w3.org/TR/webaudio/#AudioBuffer). The processor
accepts finite peaks without clipping. Missing input produces silent blocks
that still advance filter state. Channel mixing rounds only after averaging.

See [validation](../docs/validation.md) for routes, microphone, worklet, layout,
contrast, pause, reduced motion, and display timing checks. The temporary counter
has been removed.
