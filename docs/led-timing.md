# LED timing review

## Decision

Use the current `esp-hal-smartled 0.18.0` `WS2812B_TIMING` preset for both Embassy RMT outputs at 80 MHz. Keep GRB order, GPIO2/GPIO22, pixel counts, and brightness limits. This is a comparison against published limits, not a measurement of the physical signal.

The driver requires an explicit timing selection. It has no universal default. The selected preset fits the documented limits below. We do not retain the previous pulses solely because the old driver used them.

## Parts and limits

The [Adafruit Sparkle Motion schematics](https://github.com/adafruit/Adafruit-Sparkle-Motion-PCB) identify LED1 as `WS2812B_SK6805_1515` in both the original and Rev D designs. Adafruit's [1515 LED data sheet](https://cdn-shop.adafruit.com/product-files/4492/Datasheet.pdf), page 7, specifies SK6805-EC15 timing. The exact fitted silicon revision has not been inspected.

The existing [repository hardware note](../musical-adafruit-sparkle-idf/README.md) identifies Bryan's four [Fibonacci256 panels](https://www.evilgeniuslabs.org/fibonacci256) as WS2812B with GRB order. The [WS2812B data sheet](https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf), page 3, supplies the pulse limits. Adafruit also records a [longer reset requirement in revised WS2812B silicon](https://blog.adafruit.com/2017/05/03/psa-the-ws2812b-rgb-led-has-been-revised-will-require-code-tweak/).

| Limit | SK6805-EC15 | WS2812B data sheet |
| --- | --- | --- |
| Zero high | 200–400 ns | 250–550 ns |
| Zero low | at least 800 ns | 700–1000 ns |
| One high | 580–1000 ns | 650–950 ns |
| One low | at least 200 ns | 300–600 ns |
| Bit period | at least 1200 ns | 650–1850 ns |
| Reset low | more than 80 us | more than 50 us; revised parts need a longer interval |

## Driver comparison

These are source-derived requested durations. The [current driver source](https://docs.rs/esp-hal-smartled/0.18.0/src/esp_hal_smartled/lib.rs.html) converts each duration to whole RMT ticks with integer division. At 80 MHz, one tick is 12.5 ns.

| Timing | Zero high/low (ns) | One high/low (ns) | Reset |
| --- | --- | --- | --- |
| [Previous driver 0.15.0](https://docs.rs/esp-hal-smartled/0.15.0/src/esp_hal_smartled/lib.rs.html) | 400 / 850 | 850 / 400 | Idle low between frames; no explicit reset pulse |
| Current `WS2812_TIMING` | 350 / 700 | 800 / 600 | 80 us |
| Current `WS2812B_TIMING`, selected | 400 / 800 | 850 / 450 | 300 us |
| Current `SK68XX_TIMING` | 320 / 880 | 640 / 560 | 300 us |

The old pulse widths fit these published limits. That does not prove that the old hardware signal was correct. The generic WS2812 preset has a zero low interval and zero bit period below the SK6805 limits. The SK68XX preset loses time when its individual pulses truncate to 80 MHz ticks: each bit becomes 1187.5 ns, below the stated 1200 ns minimum. The selected WS2812B durations convert exactly to ticks. Their bit periods are 1200 and 1300 ns. The SK6805 zero high time sits at its stated upper limit, so hardware confirmation matters.

The current ESP-IDF LED driver requests 400/850 and 800/450 ns with a 10 MHz clock. Its HAL converts these to 400/800 and 800/400 ns. Those bit periods are 1200 ns and fit the same published pulse limits. Its application waits for audio between frames. The active IDF external output is a 400-pixel net; its exact LED part remains to be confirmed. This review does not change its existing panel mapping or brightness.

## Physical verification still required

Identify the fitted LED revisions and the IDF net part. Measure zero pulses, one pulses, and reset low time at the onboard input and the first external LED input. Check RGB order, black frames, low brightness decay, alternating data, and sustained full frame updates under audio/sensor load. Record the RMT clock, supply, wiring, frame size, and results. No boards were available for these checks during this upgrade.
