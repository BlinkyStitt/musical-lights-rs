# Musical lights in the terminal

Use Rust `nightly-2026-09-10`. The default binary uses the shared Bark processor:
24 analysis bands, five combined bass bands, and 20 display values.
The separate FFT binary and Pacman example remain available.

On macOS:

```sh
brew install sdl2
export LIBRARY_PATH="$(brew --prefix sdl2)/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
```

On Linux, install ALSA and SDL2 development libraries.
From this directory:

```sh
cargo run --release --locked
cargo run --release --locked --bin fft
cargo run --locked --example pacman
cargo run --release --locked --example microphone_check
```

The microphone check processes ten seconds without saving audio.
The input path prefers Loopback Audio, then the MacBook microphone, then the
system default. It uses a supported device rate, converts input to mono, and
retains partial blocks between callbacks. A full display queue drops a block
instead of blocking the audio callback. Stream errors appear in the log.

See [validation](../docs/validation.md) for builds, tests, and measured CPU cost.
