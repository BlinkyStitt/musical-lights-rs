# Sparkle Motion with Embassy

This ESP32 application uses esp-hal 1.2.1, esp-rtos 0.4.0, and esp-hal-smartled 0.18.0.
Use the named toolchain `esp-1.98.1.0`. See the root [setup guide](../README.md).

```sh
. "$HOME/export-esp-1.98.1.0.sh"
cargo build --release --bins --locked
```

`musical-adafruit-sparkle` retains the RMT rainbow, I2S DMA input, and LSM9DS1
initialization tasks. The radio task remains a placeholder; it does not exchange
LoRa messages. `priority` demonstrates the interrupt executor.
The LED frame now receives the calculated colors. Pixel order, pins, and
brightness limits remain the same. The current WS2812B timing preset replaces
the old pulse calculation. See the [timing review](../docs/led-timing.md).

Firmware links pass. Physical microphone, sensor, radio, and LED tests remain pending.
