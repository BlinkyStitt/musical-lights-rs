# Musical Lights

Rust code for making lights blink to music.

## Reading

- [The Rust Book](https://doc.rust-lang.org/book/)
- Hanning and other window functions
- FFT
- A-weighting, ISO-226:2023, and other equal-level-loudness contours
- Bitbanging with SPI
- Color spaces (HSLuv and RGB8)
- Splines and Gradients
- Gamma correction
- Level shifters
- wasm_bindgen
- reactive signals

## Core

The "core" library can be used on any platform. It does not use the std library or an allocator. This makes some things harder to build, but works on pretty much anything. There are some optional features that bring in "std" and other features.

    ```bash
    RUST_LOG=trace cargo test --features log
    ```

## Mac

    ```bash
    cd musical-terminal
    cargo run --release
    ```

## Feather M0

    ```bash
    rustup target add thumbv6m-none-eabi
    ```

    ```bash
    cargo install cargo-hf2
    ```

    ```bash
    cd musical-feather-m0
    cargo check
    cargo hf2 --release
    ```

## STM32

Setup:

    ```bash
    rustup target add thumbv7em-none-eabihf
    ```

    ```bash
    cargo install cargo-hf2
    ```

Being careful about how the stm32 is powered, plug it into your computer's USB port. Then:

    ```bash
    cd musical-stm32
    cargo check
    cargo run --release
    ```

## TODO

- [ ] defmt instead of log in musical-lights-core
