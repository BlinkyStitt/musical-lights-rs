# Musical Lights

Rust code for making lights blink to music.

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

    ```bash
    rustup target add thumbv7m-none-eabi
    ```

    ```bash
    cargo install cargo-hf2
    ```

    ```bash
    cd musical-stm32
    cargo check
    cargo hf2 --release
    ```

## TODO

- [ ] defmt instead of log in musical-lights-core
