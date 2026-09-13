# Fullscreen performance evidence

The baseline release comes from `173f74a96919d566360f71bfda138e13a74a4513`.
The optimized release adds bounded collision math, early contact rejection,
cached style handles, and color updates only after color changes. Its Rust and
WASM release optimizers use level 3 instead of size level `z`. Both releases
retain 24 bars, 24 compressible balls, and 5% headroom. JSON files record the
release index and worklet SHA-256 hashes, host identity, and browser versions.

Run from the repository root with host browser access:

```sh
.tools/bin/node validation/measure-spectrum.mjs "$PWD" local /tmp/spectrum.json
```

The optional fourth argument filters profile names, for example `beats`.
To compare another release, supply a directory that contains its frozen
`musical-leptos/dist` output as the first argument. Run profiles serially on an
otherwise idle host. The tool runs the serial browser startup check first.

Each profile warms for five seconds and measures for thirty seconds with a real
AudioWorklet and transferable snapshots. The normal input combines two tones,
slow amplitude changes, and seeded noise. Beat profiles supply a bass pulse and
a decaying noise burst every half second. The producer continues to process
audio during a separate 300 ms page stall; the consumer checks recovery without
a backlog. Screenshots and Chromium CPU profiles are saved beside the JSON.

`totalAppRafMsPerFrame` sums the audio-display and ball callbacks that share one
animation timestamp. FPS measures delivered animation callbacks. Neither value
measures GPU presentation. Chromium records a CPU profile and browser task,
script, layout, and style costs. The JSON also records DOM reads and CSS writes.

The portrait WebKit profile uses a 390 x 664 CSS viewport within a 390 x 844
screen at device scale 3. The landscape viewport is 844 x 390. Chromium uses
a 390 x 844 viewport at scale 3. WebKit runs on macOS.
Chromium's fourfold CPU throttle provides a slower comparison; it
does not emulate an iPhone CPU or GPU. These results do not establish physical
iPhone 16e performance, thermal behavior, or power use.

`baseline.json` contains the six normal/steady fullscreen profiles. The separate
`baseline-beats.json` contains the two fullscreen beat profiles. The normal files
predate the explicit `percussion` field; their input is the unchanged two-tone
waveform. `math.json` records the intermediate math change before the rendering
cache. `math-and-color.json` and `math-and-color-beats.json` add that cache but
still use the original size optimization settings. These intermediate results
isolate the sources of the gain and the remaining cost during repeated beats.
`final.json` contains all eight profiles with level 3 optimization. It includes
explicit viewport sizes and device scale factors. The final run also asserts
the actual fullscreen state before timing each view.
Raw CPU profiles and generated screenshots are local diagnostic artifacts;
they are not included in this directory.
