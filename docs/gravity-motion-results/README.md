# Gravity release, balanced scrolling, and vibrant rainbow

Bars retain their fast attacks but now fall with a fixed visual gravity of
2 bar heights/s² and a terminal speed of 1.2 bar heights/s. The latest audio
level stops the fall exactly. Full-height release from rest takes about 1.13 s;
Reduced Motion halves the speed and quarters the acceleration.

Scrolling reverses smoothly every eight seconds on a 16-second cycle. Its
average absolute speed is unchanged. A 64-second native collision regression
keeps the mean ball position below the rightmost quarter of the room; it fails
with the previous continuously rightward engine. Stop/resume, edge recycling,
source identity, and deterministic replay remain covered.

The rainbow uses full HSLuv saturation and full RGB value with a thin dark
outline. The 180 ms white attack flash stays one pixel wide, inside that outline.

- [Light theme](rainbow-light.png)
- [Dark theme](rainbow-dark.png)
- [Fullscreen timing and engine hash](fullscreen-timing.json)

Local validation passed: 40 native physics tests, native/WASM Clippy, Leptos
validation, 13 harness checks, and all 204 Chromium/WebKit browser tests with
host access. No new macOS browser crash reports appeared. The browser suite
includes text/boundary contrast, color-vision emulation, keyboard and pointer
identity, the gravity Stop check, and leftward seam interpolation.

The separate fullscreen measurement passed the existing 60 FPS thresholds:
Chromium measured 60.00 FPS with p95 frame intervals ≤16.8 ms; Mac WebKit measured
59.98–61.00 FPS with p95 18 ms. No frame exceeded 19 ms. Maximum simulation debt
was 7.34 ms and snapshot age 22 ms, with zero discarded simulation time. The
full-suite fullscreen test measured 7.93 ms debt and 18.84 ms snapshot age.
These are local host measurements, not Linux CI or physical-phone evidence.

Reproduce from the repository root with pinned tools:

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py physics leptos
# Both browser commands require host access on macOS.
python3 validation/validate.py browser
node validation/fullscreen-timing.mjs https://musical-lights.test timing.json --expect-clean
```

Physical iPhone smoothness remains unverified. Physics protocol 6 marks this
engine change; historical recordings require their historical engine. The
24-band acoustic analysis, shared gain, filtering, eight balls, and fixed
120 Hz simulation clock are unchanged.
