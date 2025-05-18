# Musical Adafruit Sparkle IDF

Rust's standard library on a tiny little $25 computer. Amazing.

# Development

    ... some steps from https://docs.esp-rs.org/

     . $HOME/export-esp.sh

    cargo binstall ldproxy

## Deploying

When flashing, you can specify the default port like this:

    cargo run --release -- -p /dev/cu.usbmodem5A4F0222811

## Crates to Investigate

Maybe useful docs:

- https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/i2s.html
- https://github.com/esp-rs/esp32-hal/blob/master/examples/serial.rs
- https://github.com/esp-rs/esp-hal/blob/main/esp-backtrace/Cargo.toml

These crates might come in handy:

- https://crates.io/crates/ws2812-esp32-rmt-driver
- https://crates.io/crates/smart_led_effects
- https://github.com/esp-rs/esp-hal-community/tree/main/esp-hal-buzzer
- https://docs.rs/dither/latest/dither/
- https://lib.rs/crates/defmt-or-log
- https://crates.io/crates/adafruit-seesaw

Crates to find:

- GPS
- LoRa
- Tilt Sensor

## PRs to follow

- https://github.com/esp-rs/esp-hal-community/pull/6

## Misc Thoughts

FastLed had a global "setBrightness" and also had some smart power management stuff to not go over a certain amps. we should figure out how to get that

    #define MAX_MILLI_AMPS_PER_LED 12
    #define MAX_MILLI_AMPS MAX_MILLI_AMPS_PER_LED * NUM_LEDS
    #define MILLI_AMPS 1600 (2A = 2000mA)

FastLed patterns make good use of `nblendPaletteTowardPalette`. does that exist in smart led? what about `beatsin8` and `beat8` and `scale8`. how much does using u8s matter on an esp32?

FastLed uses a global hue as the basis for a bunch of patterns. just increment that on a timer and all the patterns work. does rust change antyhing about that pattern?

Do we want a delay to keep the frame rate modest, or do we want to just run it full speed? probably modest to keep cpu down? but also whats the point of having the audio reading all the time if we aren't trying to display that?

Fastled would use a "clockless" spi setting. is that what the rust library is doing for you

Fastled 3.9.2 can "overlock" the ws2812

The 4 [fibonnaci256](https://www.evilgeniuslabs.org/fibonacci256) panels that i have are ws2812b color_order=grb

<https://randomnerdtutorials.com/esp32-spi-communication-arduino/>

[eventloop](https://github.com/esp-rs/esp-idf-svc/blob/master/examples/eventloop.rs) or flume?
