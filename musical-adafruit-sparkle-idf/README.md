# Musical Adafruit Sparkle IDF

Rust's standard library on a tiny little $25 computer. Amazing.

The default `net` binary runs the 400-pixel net and its onboard microphone at
48 kHz. It starts only the audio and LED resources. Sensor-board readiness does
not control startup. `light-check` remains a separate bench application.

The `amulet` binary drives a Fibonacci256 circle, halo, inner ring and outer
ring. It supports Map, Compass and Patterns through the USB console. The STM32
sensor application starts acquisition independently. See [firmware configuration,
wiring and physical acceptance](../docs/firmware.md).

# Development

Use ESP-IDF `v6.1`, toolchain `esp-1.98.1.0`, and `espup 0.17.1`.
The coordinated Git revisions in Cargo.toml add IDF 6.x support beyond the
published Rust crates. The LED driver uses the current RMT API.
See [dependency pins](../docs/dependencies.md).

Follow the root [setup guide](../README.md), then run:

```sh
. "$HOME/export-esp-1.98.1.0.sh"
cargo build --release --bins --locked
```

Use Python 3.10 or newer for IDF setup. The validated host uses Python 3.14.7.
Run each command from this directory. Load the generated ESP environment in
each new shell. The LED thread creates and owns its RMT drivers.

## Deploying

When flashing, you can specify the default port like this:

    RUST_BACKTRACE=1 cargo run --release -- -p /dev/cu.usbmodem5A4F0222811
