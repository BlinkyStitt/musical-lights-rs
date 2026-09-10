# Musical Lights

Rust applications that make lights respond to audio.

See the [upgrade plan](docs/upgrade-plan.md) for the agreed scope and added checks.

The shared processor analyzes 24 Bark bands. The website and terminal display
all bands separately. The 20×20 LED panel retains 20 rows, with the five bass
bands combined before normalization. Leptos, the terminal filter-bank visualizer,
and ESP-IDF use the same processor. Weighting, compression, adaptive
normalization, and bass combination are visual approximations. They do not
implement or claim compliance with an ISO loudness standard.

## Pinned tools

Non-ESP packages use `nightly-2026-09-10`. The toolchain files install rust-src,
rustfmt, Clippy, and the WASM and ARM targets. Each package has its own manifest;
the root workspace contains only `musical-lights-core`.

```sh
rustup toolchain install nightly-2026-09-10 --profile minimal \
  --component rust-src,rustfmt,clippy \
  --target wasm32-unknown-unknown,thumbv6m-none-eabi,thumbv7em-none-eabihf
python3 validation/install_tools.py web
export PATH="$PWD/.tools/bin:$PATH"
```

This installs Node `26.8.2`, Trunk `0.22.0-beta.5`, Dioxus CLI `0.8.0-alpha.1`, and
wasm-bindgen CLI `0.2.128`. Cargo manifests pin direct dependencies and the
independent lockfiles freeze their resolved graphs. See [dependency inventory](docs/dependencies.md).

For ESP32, install the named Xtensa toolchain explicitly:

```sh
python3 validation/install_tools.py esp
export PATH="$PWD/.tools/bin:$PATH"
espup install --toolchain-version 1.98.1.0 --name esp-1.98.1.0 \
  --targets esp32 --export-file "$HOME/export-esp-1.98.1.0.sh"
. "$HOME/export-esp-1.98.1.0.sh"
```

The installer uses espup `0.17.1` and ldproxy `0.3.5`. ESP-IDF targets `v6.1`.
Use Python 3.10 or newer for IDF setup. See the [official espup instructions](https://github.com/esp-rs/espup#usage)
and [Xtensa releases](https://github.com/esp-rs/rust-build/releases).

## Run or build

Run these commands from the named package directory.

| Package | Command |
| --- | --- |
| musical-lights-core | `cargo test --locked --features log` |
| musical-terminal | `cargo run --release --locked` |
| musical-leptos | `trunk serve` |
| musical-dioxus | `dx serve --web` |
| musical-wasm | `python3 run.py` |
| musical-feather-m0 | `cargo build --release --bins --locked` |
| musical-stm32 | `cargo build --release --bins --locked` |
| musical-adafruit-sparkle-embassy | `cargo build --release --bins --locked` |
| musical-adafruit-sparkle-idf | `cargo build --release --bins --locked` |

On macOS, install SDL2 for terminal examples and set its library search path:

```sh
brew install sdl2
export LIBRARY_PATH="$(brew --prefix sdl2)/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
```

## Validate

From the repository root, with the ESP environment loaded:

```sh
python3 validation/validate.py all
```

Select individual packages when needed, such as `core terminal`, `leptos dioxus
wasm browser`, or `stm32 feather esp-embassy esp-idf`. Browser tests build no
applications themselves; build the three web packages first.

[Validation evidence and limits](docs/validation.md) records tests, compiler
identities, processor cost, and pending physical hardware checks. No validation
command flashes firmware. The Feather application and several radio/sensor
paths remain unfinished; successful links do not establish hardware operation.
