# Musical Lights

Rust code for making lights blink to music.

## Reading

- [The Rust Book](https://doc.rust-lang.org/book/)
- Hanning and other window functions
- FFT
- A-weighting, ISO-226:2023, and other equal-level-loudness contours
- Biquads
- Bitbanging with SPI and RMT
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

- <https://www.youtube.com/watch?v=PAsMlDptjx8>

Bosi, M. & Goldberg, R. – “Filter Banks in Perceptual Audio Coding.”
In Introduction to Digital Audio Coding and Standards, Chap 3, Springer, 2003.
Classic tutorial on cascaded analysis banks (4‑pole, critical‑band spacing) used in MPEG/AAC.

Zwicker, E. – “Procedure for Calculating Loudness of Time‑Variant Sound.” JASA (1977).
Introduces the 20‑50 ms loudness integration window that modern short‑term models still use.

Zwicker, E. & Fastl, H. – Psycho‑Acoustics: Facts and Models, 3 rd ed., Springer, 1999.
Definitive reference for Bark scale, critical‑band masking, and temporal adaptation.

Glasberg, B. & Moore, B. – “A Model of Loudness Applicable to Time‑Varying Sounds.” AES 113 (2002).
Cube‑root compression and adaptive smoothing adopted in many codecs.

ISO 532‑1 / ECMA‑418‑2 (2023) – Measurement of Perceived Loudness, Time‑Varying Method.
Standardises the Zwicker/Glasberg short‑term loudness algorithm (30 ms integration).

Moore, B., Glasberg, B. & Roberts, B. – “Refining the Calculation of Auditory Filter Bandwidth.” JASA (1984).
Source of the ERB (= equivalent rectangular bandwidth) scale; often compared to Bark.

Irino, T. & Patterson, R. – “A Time‑Domain, Level‑Dependent Gammatone Filter Bank.” ICASSP (2001).
Shows how higher‑order (4‑pole) gammatone filters better match cochlear skirts.

Brandenburg, K. & Bosi, M. – “Overview of MPEG‑1 Audio Layer III.” AES 101 (1996).
Demonstrates Bark‑bank energy → dB → psycho‑model workflow in MP3.

Herre, J. & Johnston, J. – “Ear to Ear: How MPEG‑4 Audio Perceptual Coding Works.” Proc. IEEE (2002).
Details temporal noise shaping and dynamic gain, confirming 30 ms smoothing.

Skoglund, J. & Valin, J.‑M. – “Voice and Audio Coding with Opus.” IETF Journal (2012).
Modern codec still uses 4‑pole critical‑band banks for the CELT mode; illustrates per‑band adaptive gain.

Schroeder, M. R. & Hall, J. W. – “Modeling Auditory Filter Shapes.” JASA (1974).
Early evidence that auditory filters have ~12 dB/oct skirts—motivation for cascading identical biquads.

Verhelst, W. et al. – “AES Recommended Practice for Loudness of Internet Audio Streaming.” AES TD1008 (2020).
Applies short‑term lo
