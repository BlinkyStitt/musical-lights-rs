# Leptos musical lights

This application uses Leptos 0.9.0-beta in CSR mode and the shared Bark processor.
It renders 20 values from 24 analysis bands. It uses the browser's actual sample
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

See [validation](../docs/validation.md) for route, counter, microphone, and worklet tests.
