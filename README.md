# Musical Lights

Rust applications that make lights respond to audio.

The browser, terminal, ESP32 net, and Rust STM32 jacket use one continuous ISO 532-1 time-varying loudness model. Every display starts with the same 24 perceived-loudness bands.

## How it works

1. Capture mono audio at 48 kHz. Calibration converts digital samples to pressure.
2. Run 28 internal third-octave filters continuously. Apply the model's hearing sensitivity, masking spread, and temporal response.
3. Produce total loudness in sones and a specific-loudness pattern across 0–24 Bark. Integrate each one-Bark region into one of the 24 display bands.
4. Apply one shared visual gain and motion filter. These change bar travel, not measured loudness. Detect attacks from changes in the same band measurements.

**ISO 532-1 is the calculation method. Bark is its hearing-frequency scale.** The 28 internal filters and 24 displayed bands describe different stages. All 28 filters contribute. A pure tone can excite adjacent hearing regions, so several bars can respond to one pitch. The display does not identify separate musical notes.

Audio block size changes how samples arrive. It does not change the model or its 2 ms output grid. The browser defaults to its normal audio block, usually 128 samples. Filters still have frequency-dependent response time; a 2 ms update does not promise 2 ms total latency. Keep 48 kHz to retain treble and the model's validated coefficients.

Below the browser scene, **Current loudness** shows sones and RMS dBFS. **Background estimate** tracks a lower percentile of recent input. It never subtracts sound or changes calibration. RMS uses exponential integration, with a default time constant of 125 ms. `~` marks estimated sones from an assumed microphone scale. dBFS measures digital level; it does not measure hearing risk.

New browser preferences use **Auto depth**. Startup frame measurements select a depth count for the observed screen cadence. The slider and numeric control allow 0–2048 images. Saved manual counts stay unchanged. Auto selects once; select Auto again to start a new measurement. Bars and balls emit faint color light. White attacks illuminate nearby surfaces throughout the depth. Advanced controls change presentation and scheduling while the ISO coefficients stay fixed.

The 20×20 net combines the first five bands into one bass row. Each row of the jacket's two 8×32 panels maps to `floor(row × 24 / 32)`. Slow displays receive the latest snapshot while analysis consumes all audio.

See [the scientific method, controls, and sources](docs/loudness.md), [validation procedures and evidence](docs/validation.md), and [physics and phone acceptance](docs/physics.md). Identical PCM, calibration, and settings produce consistent analysis; different microphones can record different signals. Firmware builds do not prove physical capture or lighting.

The ISO reference validator uses Python 3.13 or newer and `uv` (tested with 0.10.5). Its dependency lockfile pins MoSQITo and the numerical tools.

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
| musical-lights-worklet | `python3 build.py` |
| musical-lights-physics | `cargo test --locked` / `python3 build.py` |
| musical-terminal | `cargo run --release --locked` |
| musical-leptos | `trunk serve` |
| musical-dioxus | `dx serve --web` |
| musical-wasm | `python3 run.py` |
| musical-feather-m0 | `cargo build --release --bins --locked` |
| musical-stm32 | `cargo build --release --bins --locked` |
| musical-adafruit-sparkle-embassy | `cargo build --release --bins --locked` |
| musical-adafruit-sparkle-idf | `cargo build --release --bins --locked` |

The Leptos build includes the shared Rust rigid-body simulation and locally
bundled Three.js renderer. See [physics and phone acceptance](docs/physics.md).
Optional [song recognition](docs/song-recognition.md) uses a Rust Cloudflare
Worker and a server-side AudD token, with opt-in microphone capture at most once
per minute and local history export.

Reusable tempo estimation, idle waves, bar motion, balanced scrolling, sphere drag, and
contact-pigment history live in `musical-lights-core`, using fixed storage and
`no_std` math. Browser and physics packages adapt them to their platform. See
[musical motion evidence and previews](docs/musical-motion-results/README.md).

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
