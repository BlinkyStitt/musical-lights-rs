# Musical Adafruit Sparkle Motion

Make an [Adafruit Sparkle Motion (ESP32)](https://learn.adafruit.com/adafruit-sparkle-motion/overview) blink to the music.

# Crates to Investigate

These crates might come in handy:

- https://crates.io/crates/ws2812-esp32-rmt-driver
- https://crates.io/crates/smart_led_effects
- https://github.com/esp-rs/esp-hal-community/tree/main/esp-hal-buzzer

Crates to find:

- GPS
- LoRa
- Tilt Sensor

# Flashing

When flashing, you can specify the default port like this:

    cargo run --release -- -p /dev/cu.usbmodem5A4F0222811

# PRs to follow

- https://github.com/esp-rs/esp-hal-community/pull/6
