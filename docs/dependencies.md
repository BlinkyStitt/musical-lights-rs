# Frozen dependency inventory

Selected on 2026-09-10. The release check includes unyanked pre-releases and chooses the highest semantic version, rather than the most recent backport publication. Registry requirements are exact. Lockfiles pin all transitive dependencies.

The user requested current releases and pre-releases. These major upgrades require source migrations; there is no parallel compatibility API.

| Direct dependency | Version or revision | Package roots |
| --- | --- | --- |
| ahrs | `0b04dfe5e23fd0af9dbea1d24116e4c5b69d3ed9` | core, stm32 |
| anyhow | `=1.0.104` | terminal |
| circular-buffer | `=2.0.1` | core, stm32 |
| cobs | `=0.5.1` | core |
| console_error_panic_hook | `=0.1.7` | leptos, wasm |
| console_log | `=1.1.0` | leptos, wasm |
| cortex-m | `=0.7.9` | feather, stm32 |
| cortex-m-rt | `=0.7.6` | feather, stm32 |
| cpal | `=0.18.2` | terminal |
| crc | `=3.4.0` | core |
| critical-section | `=1.2.0` | terminal, esp-embassy |
| dagc | `=0.1.1` | esp-idf |
| defmt | `=1.1.1` | core, stm32, esp-embassy |
| defmt-rtt | `=1.3.0` | stm32 |
| dioxus | `=0.8.0-alpha.1` | dioxus |
| embassy-embedded-hal | `=0.6.0` | stm32 |
| embassy-executor | `=0.10.0` | terminal, feather, stm32, esp-embassy |
| embassy-futures | `=0.1.2` | stm32, esp-embassy |
| embassy-stm32 | `=0.6.0` | stm32 |
| embassy-sync | `=0.8.0` | terminal, feather, stm32, esp-embassy |
| embassy-time | `=0.5.1` | core, terminal, stm32, esp-embassy |
| embedded-alloc | `=0.7.0` | stm32 |
| embedded-graphics | `=0.8.2` | terminal, esp-idf |
| embedded-graphics-simulator | `=0.8.0` | terminal |
| embedded-io | `=0.7.1` | esp-embassy |
| embedded-io-async | `=0.7.0` | stm32, esp-embassy |
| embuild | `=0.33.5` | esp-idf (build) |
| enterpolation | `=0.3.0` | core, stm32 |
| env_logger | `=0.11.11` | terminal |
| esp-alloc | `=0.11.0` | esp-embassy |
| esp-backtrace | `=0.20.0` | esp-embassy |
| esp-hal | `=1.2.1` | esp-embassy |
| esp-hal-smartled | `=0.18.0` | esp-embassy |
| esp-idf-svc | `=0.52.1` | esp-idf |
| esp-println | `=0.18.0` | esp-embassy |
| esp-rtos | `=0.4.0` | esp-embassy |
| eyre | `=0.6.14` | esp-idf |
| feather_m0 | `=0.20.4` | feather |
| flume | `=0.12.0` | terminal, leptos, esp-idf |
| heapless | `=0.9.3` | core, feather, stm32, esp-embassy, esp-idf |
| i24 | `=2.3.5` | core |
| infrared | `=0.14.2` | esp-idf |
| itertools | `=0.15.0` | core, stm32, esp-idf |
| js-sys | `=0.3.105` | leptos, dioxus, wasm |
| leptos | `=0.9.0-beta` | leptos |
| leptos_router | `=0.9.0-beta1` | leptos |
| log | `=0.4.34` | core, terminal, leptos, dioxus, feather, esp-idf |
| lsm9ds1 | `eacd62cb6a1c2dda962ed8d2546566925472e586` | stm32, esp-embassy |
| microfft | `=0.6.0` | core |
| micromath | `=2.1.0` | core, stm32 |
| musical-lights-core | `../musical-lights-core` | terminal, leptos, worklet, dioxus, feather, stm32, esp-embassy, esp-idf |
| nalgebra | `=0.35.0` | core, stm32 |
| num | `=0.4.3` | core, leptos |
| num-complex | `=0.4.6` | core |
| once_cell | `=1.21.4` | esp-idf |
| palette | `=0.7.7` | core, stm32 |
| panic-halt | `=1.0.0` | feather |
| panic-probe | `=1.0.0` | stm32 |
| panic-semihosting | `=0.7.0` | feather |
| postcard | `=1.1.3` | core, stm32, esp-idf |
| serde | `=1.0.229` | core, stm32, terminal |
| sonic-rs | `=0.5.8` | terminal calibration profiles |
| resampler | `=0.5.1` | terminal non-48-kHz input |
| smart-leds | `=0.4.0` | core, stm32, esp-embassy, esp-idf |
| smart-leds-matrix | `=0.2.0` | terminal |
| smart-leds-trait | `=0.3.2` | stm32, esp-idf |
| static_cell | `=2.1.1` | terminal, stm32, esp-embassy, esp-idf |
| sx1262 | `=0.3.0` | esp-embassy |
| terrors | `=0.3.3` | leptos |
| test-log | `=0.2.21` | core (dev) |
| thiserror | `=2.0.20` | core |
| wasm-bindgen | `=0.2.128` | leptos, dioxus, wasm |
| wasm-bindgen-futures | `=0.4.78` | leptos, dioxus, wasm |
| wasm-bindgen-test | `=0.3.78` | leptos (dev), dioxus (dev) |
| web-sys | `=0.3.105` | leptos, dioxus, wasm |
| ws2812-async | `=0.4.0` | stm32, esp-embassy |
| ws2812-esp32-rmt-driver | `=0.15.0-alpha.1` | esp-idf |

## Git revisions and patches

| Source | Revision | Reason |
| --- | --- | --- |
| [ahrs-rs](https://github.com/jmagnuson/ahrs-rs) | `0b04dfe5e23fd0af9dbea1d24116e4c5b69d3ed9` | Upstream AHRS uses nalgebra 0.35; core and STM32 share its public vector and quaternion types. |
| [lsm9ds1](https://github.com/BlinkyStitt/lsm9ds1) | `eacd62cb6a1c2dda962ed8d2546566925472e586` | Retain the existing asynchronous sensor interface used by both firmware applications, with an immutable revision. |
| [esp-idf-svc](https://github.com/esp-rs/esp-idf-svc) | `81d64e2b23d8f1984e137e3b9760054e4d2e90e8` | Upstream ESP-IDF 6.x service support beyond the published release. |
| [esp-idf-hal](https://github.com/esp-rs/esp-idf-hal) | `846cff17f3701b836fe461b6751d9e5c42b4b278` | Coordinated IDF 6.x HAL APIs; also used by the RMT LED driver. |
| [esp-idf-sys](https://github.com/esp-rs/esp-idf-sys) | `33045844f467fb8c66dfd78c3cacb0e218c3d26a` | Generate bindings and build ESP-IDF v6.1. |

The three IDF entries are the only crates.io patches. Their lockfile versions remain 0.52.1, 0.46.2, and 0.37.2; their Git revisions contain the additional support. ESP-IDF v6.1 resolves to `fff9895c82d744c7237be8847347bdd1b07c6643`.

The ISO loudness implementation replaces the empirical Bark bank and removes the biquad dependency. MoSQITo 1.2.1 is a pinned validation oracle, not a runtime dependency. See `validation/loudness/uv.lock` and `THIRD_PARTY_NOTICES.md`.

Unused ESP networking dependencies bleps, embassy-net, esp-wifi, and smoltcp were removed. esp-rtos replaces esp-hal-embassy. Core no longer depends on unused ed25519-dalek, embedded-io, embedded-io-async, extfn, or the unrelated pallete crate. STM32 no longer pulls in unused anyhow. IDF no longer initializes an unused RNG or retains the unused biski64/rand dependency pair.

## Build and test tools

| Tool | Version |
| --- | --- |
| Host Rust | nightly-2026-09-10 |
| Xtensa Rust | esp-1.98.1.0 |
| espup | 0.17.1 |
| ldproxy | 0.3.5 |
| Trunk | 0.22.0-beta.5 |
| Dioxus CLI | 0.8.0-alpha.1 |
| wasm-bindgen CLI | 0.2.128 |
| Node | 26.8.2 |
| Playwright test | 1.64.0-alpha-2026-09-10 |

The browser test runner uses its matching Chromium build. `validation/package-lock.json` pins its graph. [Registry release-check data](dependency-release-check.json) records the original dependency review, including dependencies later removed.
