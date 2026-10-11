# Browser visualizer

The Home and Advanced pages use the shared core ISO 532-1 processor. Its 28 continuous third-octave filters produce a specific-loudness pattern across 24 Bark. Each displayed band integrates one Bark. The browser no longer computes FFT source-band partial loudness.

See [the basic project README](../README.md) for setup and usage and [the model and research](../docs/loudness.md) for units, calibration, timing, and controls. Build from the repository root with the pinned tools:

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py leptos
```

Listening controls microphone capture. Digital playback and phone motion have independent lifetimes. Local audio files stay in browser memory. Song identification remains opt-in.

Current and background readouts show sones and RMS dBFS. Uncalibrated sones are estimates. Background tracking does not subtract noise or change calibration. Advanced settings change presentation and scheduling; ISO coefficients stay fixed. Audio settings apply at the next explicit audio start. The actual audio block size appears below the scene.


Browser evidence does not establish physical-phone frame rate or hardware acceptance. Keep diagnostic recording off during frame-rate acceptance workloads.

Share metadata lives in `index.html`, so preview services can read it without
JavaScript. Trunk copies `public/social-preview.png` to the site root. The PNG
is 1200×630 and uses the shared rainbow palette. Open Graph and Twitter image
cards point to its public HTTPS URL. The app does not inject duplicate metadata.

To regenerate the image, build the Leptos application, then run the following
from `validation/` with the pinned Node and browser tools installed:

```sh
npm run preview
```

The renderer reads the actual app colors, draws a static illustration, and saves
the PNG. Rebuild Leptos after regeneration to copy the updated image into `dist/`.
Preview services can cache existing cards; check the sharing app after deployment.
