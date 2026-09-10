# Standalone WASM audio worklet

Use `nightly-2026-09-10` and `wasm-bindgen-cli 0.2.128`.
From the repository root, run `python3 validation/install_tools.py web`, then add
`.tools/bin` to `PATH`.

From this directory, run:

```sh
python3 build.py
python3 server.py
```

Open <http://localhost:8080>. Move the volume slider to start audio.
`python3 run.py` builds and serves in one command.

The build script rebuilds the standard library with atomics, links imported shared
memory, exports TLS metadata, and checks that the WASM bindings match the CLI.
The server sends COOP and COEP headers. Serve these headers in production too.
Keep the worklet's TextEncoder/TextDecoder support: AudioWorkletGlobalScope does
not provide those browser APIs.

Run `python3 validation/validate.py wasm browser` from the repository root after
building the other web applications. See [validation](../docs/validation.md).
