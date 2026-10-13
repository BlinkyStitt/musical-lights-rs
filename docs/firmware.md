# Net, amulet and sensor firmware

`net` remains the default ESP-IDF application. It drives the 400-pixel net from
its microphone. `amulet` uses the same pinned SDK and shared audio core. It drives
four separate outputs: Fibonacci256 circle on GPIO21, 64-pixel halo on GPIO23,
84-pixel inner ring on GPIO22, and 90-pixel outer ring on GPIO19. The three ring
counts are provisional. The fourth output is a level-shifted header connection.
The installed RGB output profile uses GRB channel order and separate, unmeasured
response functions. Verify channel order on the supplied parts before use.

The STM32 application is `sensors_for_sparkle`. It starts GPS, PPS, motion sensors,
radio and board communication independently. A missing display does not stop
acquisition. A component fault removes its available data and leaves the other
tasks running. Battery state stays Unknown: no measured battery profile exists.
No application uses buttons or input pairing.

## Build and verify

Run from the repository root. ESP-IDF needs Python 3.10 or later. The existing
validation environment provides Python 3.14 on this development machine.

```sh
PATH="$PWD/.tools/bin:$PATH" python3 validation/validate.py core
PATH="$PWD/.tools/bin:$PATH" python3 validation/validate.py stm32
PATH="$PWD/validation/loudness/.venv/bin:$PWD/.tools/bin:$PATH" python3 validation/validate.py esp-idf
uv sync --project tools/firmware --locked
uv run --project tools/firmware --locked python -m unittest discover -s tools/firmware
```

The release ELFs are `musical-stm32/target/thumbv7em-none-eabihf/release/sensors_for_sparkle`
and `musical-adafruit-sparkle-idf/target/xtensa-esp32-espidf/release/{net,amulet}`.
Hello carries the first eight bytes of the source commit ID. Keep the full commit,
artifact SHA-256, compiler and SDK versions with a firmware delivery. Compilation
and artifact creation do not flash a board.

The F411CE linker reserves sectors 6 and 7 for storage. Firmware must fit below
`0x08040000`. Do not flash this layout to a smaller part. UART uses Postcard in an
`Envelope { version: 1, message }`, CRC-16/IBM-SDLC, COBS, and a zero delimiter.
Variant numbers are Hello=0, StateSnapshot=1, Command=2, CommandResult=3,
Heartbeat=4 and CalibrationBatch=5. Frames cannot exceed 512 bytes. Old sensor
payloads are rejected. Snapshots publish at 20 Hz, or 5 Hz during calibration.

## Wiring and timing

| STM32 function | Pins or resource |
| --- | --- |
| Sparkle UART1 RX / TX | PA10 / PB6; DMA2 streams 5 / 7 |
| GPS UART2 RX / TX | PA3 / PA2; DMA1 streams 5 / 6 |
| GPS enable | PB7, **high enables** product 746 |
| GPS PPS | PA0, TIM2 CH1, 1 MHz capture |
| SPI1 SCK / MISO / MOSI | PA5 / PA6 / PA7; DMA2 streams 0 / 3 |
| Accelerometer / magnetic CS | PA8 / PA9 |
| Radio CS / DIO0 / reset | PB0 / PB5 / PB12 |
| Embassy clock | TIM5, 1 MHz |

SWD PA13/PA14 and USB PA11/PA12 remain free. SPI transactions use one async bus
mutex. Radio airtime does not hold that mutex. Data-ready status registers control
new IMU reads. Samples use m/s², rad/s and microtesla after conversion from native
register units. Apply calibration before the installed body-frame transforms.

GPS uses 9600 baud, 1 Hz RMC/GGA output, valid checksums and matching epochs.
Its parser preserves validity, age and hemisphere signs. Altitude for WMM is GGA
MSL altitude plus geoid separation. Positions stay in RAM. Five measured PPS/UTC
anchors acquire the clock; ordinary corrections slew by at most 5 ms/s. Holdover
expires at 250 ms uncertainty or 30 minutes. Large corrections fade the shared
pattern out and back in. Roster slot, not reachable-peer count, selects its section.

**The product-746 PPS/epoch timing bound has not been measured. Devices default to
unknown timing and therefore stay Acquiring.** Install a measured profile through
the existing atomic STM configuration transaction:

```text
config begin stm
config set gps.timing OFFSET,MIN_DELAY,MAX_DELAY,UNCERTAINTY,DRIFT
config validate
config commit
```

Replace the five fields with measurements; the command does not accept their
names. `OFFSET` is PPS UTC minus the matching NMEA epoch in milliseconds
(-1000, 0 or 1000). The delay limits bound completion of the first matching
RMC/GGA sentence relative to that PPS (0–999 ms, inclusive). Include UART transfer,
DMA batching, task scheduling and timestamp quantization in the timing measurements.
`UNCERTAINTY` bounds PPS UTC error in milliseconds (1–50). `DRIFT` is the measured
worst-case local clock drift in ppm (1–100). Holdover conservatively uses 100 ppm,
even when the measured bound is lower. Reject a hardware profile outside these
limits; do not reduce measured values to make it pass.

The STM32 validates the profile again, stores it with command completion, and
starts fresh clock acquisition after a committed timing change. It accepts only
whole-second epochs inside the installed delay limits. `config set gps.timing
unknown` removes the profile. `config get stm` reports the public profile, and
`gps diagnostics` reports its installed uncertainty without coordinates. The STM
settings record uses schema 2; schema 1 records are rejected. The board UART
envelope and six message variants remain version 1. Use matching STM32, amulet
and provisioning tools. No physical synchronization is claimed by the synthetic
Locked, Holdover, expiry and correction tests.

## USB configuration

Connect Sparkle GPIO9 TX to STM32 PA10 RX and GPIO10 RX to PB6 TX, with shared
ground and the specified 3.3 V logic supply. The USB console stays separate.

```sh
uv run --project tools/firmware --locked python tools/firmware/provision.py --port /dev/cu.YOUR_DEVICE
```

Start with `status`. Configure STM32 with `config begin stm`, then `config set`
for `identity.device_id`, `identity.group_id`, `identity.key_id`, `peers.revision`
and `peers.roster`. Use a sorted `id:color,id:color` roster of 1–8 devices, including
self, with unique IDs and palette colors 0–7. `config secret group_key` opens a
hidden host prompt for 32 nonzero key bytes. Run `config validate` and `config commit`.
Never put a key in command arguments, shell history or an exported record.

Configure Sparkle with `config begin sparkle`. Set `power.total_mA`,
`power.reserve_mA`, `power.circle_mA`, `power.halo_mA`, `power.inner_ring_mA`
and `power.outer_ring_mA` to the commissioned supply and branch limits. There is
no operational power default. Each branch must cover its LED idle load; branch
budgets plus the controller reserve cannot exceed the total. Validate and commit.
All four outputs remain black until these required settings are valid. Limits
use encoded drive bytes and a conservative, unmeasured current model.

The US development radio profile uses 915 MHz, +13 dBm, SF7, BW250 kHz, CR4/5,
eight preamble symbols, explicit headers, payload CRC and private sync word 0x12.
Relay mode defaults off. Enable it with `config set radio.relay_enabled true`
only after direct reception tests. Origin reports have priority. One relay token
per five seconds bounds the eight-device offered airtime calculation to 18.88%.
This is a calculation, not measured capacity or a worldwide radio profile.

After provisioning, `mode Map`, `mode Compass`, `mode Patterns`, `peer ID`,
`range METERS`, `brightness PERCENT`, `blank true|false` and `pattern 0..4` commit
and apply immediately. Brightness values are 5, 10, 25, 50 and 100. Ranges are
100, 250, 500, 1000, 2000 and 5000 m. `peer none` clears the target. The config
interface also sets map orientation and a 2–60 second pattern cycle.

Use `config get stm` for redacted public settings and `config get sparkle` for
local settings. `key check` tests key agreement with a fresh public challenge.
It prints IDs and pass/fail, never the key. `gps diagnostics` returns counters
and timing/HDOP diagnostics without coordinates.

Settings, boot counters and command completion use atomic records. A sent mutation
stays pending across a Sparkle restart. Lost results cause retry with the same
identity; STM32 returns its durable completion rather than applying twice. Use
`command status` after a timeout. Expired history cannot prove completion and
leaves the pending request unresolved. Do not create a new write to hide that
state. Corrupt storage disables mutations; it does not silently restore old data.

## Sensor calibration

Collect native samples with `tools/firmware/calibrate_sensors.py collect`.
Use one `rotate` capture and six stationary captures labeled `+x`, `-x`, `+y`,
`-y`, `+z`, `-z`. The labels refer to the installed sensor/body profile. Keep each
capture and the solver report on persistent development storage. Any stream loss
or restart invalidates collection. The tool uses the same console client and
board codec as provisioning.

Run `fit` with the CSV paths, explicit sensor profile, mount revision, next
calibration revision and output path. The solver reserves every fifth magnetic
sample for holdout. It checks all 24 equal-area coverage bins, matrix conditioning
and radial errors. The 120-byte candidate includes units, revisions and CRC.
Begin a new calibration run, then use `stage --run RUN_ID CANDIDATE` to upload it.
Collection limits display intent to 5%. Stage applies a volatile preview and
releases that collection limit. Use `calibration load RUN_ID white` for a temporary
white test frame, or `calibration load RUN_ID off` to restore rendering. The override
ends on Save, Cancel, lease timeout or restart and respects blanking/current caps. `calibration preview RUN_ID` returns its digest
and heading. `calibration save RUN_ID SHA256` commits it; Cancel, timeout or restart
discards the preview. No fitting result proves physical north accuracy.

Before Save, check independent cardinal headings, ±30° tilt, permitted LED load
and radio transmission. Physical acceptance must also measure GPS/PPS timing,
eight-device radio capacity, all four output timings, optical response, current,
thermal behavior and runtime. Firmware builds and synthetic tests establish none
of those results. Enclosure work, battery-circuit construction and flashing remain
separate tasks.
