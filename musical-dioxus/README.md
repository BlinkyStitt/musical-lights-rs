# Dioxus page

The application and CLI both use `0.8.0-alpha.1`. Use Rust `nightly-2026-09-10`.
From the repository root, run `python3 validation/install_tools.py web`, then add
`.tools/bin` to `PATH`.

```sh
dx serve --web
dx build --web --release --locked
```

Run these commands from this package directory. The release page is in
`target/dx/musical-dioxus/release/web/public/`.

This application currently renders the project page and links. It has no microphone processor.
See [validation](../docs/validation.md) for the visible page test.
