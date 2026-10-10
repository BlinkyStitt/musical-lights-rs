# Musical STM32

Run the pinned checks from the repository root:

```sh
python3 validation/validate.py stm32
```

The `merbots_jacket` binary uses ADC1 on PA0, DMA2 stream 0, and TIM2 TRGO.
HSI and the PLL supply nominal 96 MHz. TIM2 divides that clock by 2000 for
nominal 48 kHz capture. Oscillator tolerance remains; the sample rate has not
been measured on a board. Each 12-bit sample becomes `(count - 2048) / 2048`.
The microphone pressure calibration is unmeasured.

One task owns capture and shared ISO loudness analysis. A DMA gap resets the
meter, display gain, targets, and acoustic edges. A bounded watch channel holds
only the latest visual snapshot. The renderer samples it at 50 Hz; it never
blocks PCM processing. The two 8×32 serpentine panels retain PB5/SPI1 and
PB15/SPI2, mirrored geometry, the mermaid palette, the startup test pattern,
and the 32/255 drive cap. Row `r` uses canonical band `floor(r * 24 / 32)`.
The shared gain controls activity. Acoustic rises control the white edges.

See [sensor mounting](../docs/sensor-mounting.md) for the core mounting API.
Mounting does not change the sensor binary's fusion or calibration algorithms.
Builds and native tests do not establish continuous capture or performance on
physical hardware. Board acceptance must measure DMA gaps and capture timing.
