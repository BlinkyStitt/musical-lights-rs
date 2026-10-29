# Browser visualizer

The Home and Advanced pages use the shared core ISO 532-1 processor. Its 28 continuous third-octave filters produce a specific-loudness pattern across 24 Bark. Each displayed band integrates one Bark. The browser no longer computes FFT source-band partial loudness.

See [the basic project README](../README.md) for setup and usage and [the model and research](../docs/loudness.md) for units, calibration, timing, and controls. Build from the repository root with the pinned tools:

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py leptos
```

For the complete local acceptance checks, install the pinned web CLIs with `python3 validation/install_tools.py web` and the workflow checker with `python3 validation/install_tools.py ci`, then run `just validate` from the repository root. This builds the native/WASM packages and all apps exercised by the full browser suite, then runs the Node harness and rendered checks. After delivery, `just check` also verifies exact-commit website CI.

Listening controls microphone capture. Digital playback and phone motion have independent lifetimes. Local audio files stay in browser memory. Song identification remains opt-in.

Current and background readouts show sones and RMS dBFS. Uncalibrated sones are estimates. Background tracking does not subtract noise or change calibration. Advanced settings change presentation and scheduling; ISO coefficients stay fixed. Audio settings apply live at acknowledged analysis boundaries; changes while stopped are saved for the next explicit start. The optional microphone activation gate uses raw sones (default floor 0.1), independently of visual gain. It opens at the floor and closes after 100 ms below 80% of the floor. Use the adjacent quiet-room background estimate as a guide; calibration is optional. Closed gating preserves raw meters and the listening wave. It does not subtract fan noise during music. Legacy dBFS floors reset only the gate, with a notice; valid gain preferences are retained. The actual audio block size appears below the scene.

The scene has eight physical balls, eight full-size background banks repeating the source bands, and one outer coating. Depth changes the physical enclosure from 20–200 cm (48 cm by default). Zoom changes only camera projection: 25–200% in 1% steps, with 100% preserving enclosure-fit framing. Use 25% to see the center and neighboring banks together. Horizontal position and Vertical position place the camera anchor within the main box, from 0–100% in 1% steps, centered at 50%. W/A/S/D adjusts the same position values continuously; typing and shortcuts do not move the camera. Angle retains its horizontal sweep and adjacent FPS readout.

Camera controls are shared by Home, Advanced and expanded Settings, with step buttons and numeric editors. Tap a camera label for help. Manual angle, zoom and position survive reload and route changes. Reset display restores 100% zoom, centered position and the existing display defaults. Reduced Motion stops the automatic sweep while allowing manual camera adjustment. Zoom and position preserve audio ownership, simulation dimensions, balls and colors.

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
