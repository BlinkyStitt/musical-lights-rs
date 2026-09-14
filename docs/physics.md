# Rigid-body prototype

The Leptos visualizer runs 24 spheres and 24 prescribed bars in Rapier 3D.
`musical-lights-physics` contains the same simulation for native tests and WASM.
The browser runs it in a dedicated Worker, separate from the AudioWorklet.
Three.js 0.186.0 draws the actual collider transforms in one WebGL2 canvas,
using one instanced sphere mesh and one instanced bar mesh.

## Physical setup

These defaults are adjustable prototype assumptions, not measured materials.

| Setting | Default |
| --- | --- |
| Width / depth | 1.2 m / 0.24 m |
| Bar pitch / gap / top corner radius | 50 mm / 2 mm / 12 mm |
| Sphere diameter | Original 24 size ratios × 48 mm |
| Density | 1,100 kg/m³ |
| Gravity | 9.81 m/s² |
| Restitution / friction | 0.85 / 0.20 |
| Maximum bar rise / fall speed | 1.0 / 1.25 m/s |
| Physics rate / solver iterations | 120 Hz / 8 |
| Visual headroom | 5% |

Rapier derives sphere mass and inertia from radius and density. It resolves
friction, angular motion, restitution, and contact impulses. Balls do not
compress, and the application does not add launch impulses.

Bars use position-based kinematic bodies. Each tick sets the next position
through a speed limit; Rapier derives contact velocity. Ball loads cannot slow
the bars. No motor force or power model is present. The audio envelope falls
25% faster than before, independently of ball gravity. Hold and edge timing
remain unchanged. The idle bar top is 3 mm above the enclosure floor.

The enclosure has a floor and four 2 mm walls. Walls reach 100 m above the
floor; there is no ceiling. The invisible portion of each bar extends 20 m
below its top. The camera height follows the measured screen aspect ratio.
Resize preserves sphere size, position, and velocity. Bars move toward their
new targets through the same controller.

Pointer interaction is a radial acceleration field within 0.22 m, with a
maximum strength of 15 m/s². Device linear acceleration already arrives in
m/s²; screen rotation maps its axes. Tilt adds an acceleration field of up to
2 m/s² per axis. The simulation applies force as mass × acceleration each tick.
Reduced motion scales external acceleration to 10% and bar speed to 25%.

## Engine selection and limits

The prototype started with Rapier 0.35.3. Its bullet CCD excludes other bullet
bodies. A native regression with two equal spheres at opposing 20 m/s speeds
reproduced tunneling. The single active dependency is therefore pinned to
Rapier 0.34.0 with enhanced determinism and CCD on every sphere.

CCD uses one substep. Multiple CCD substeps can give position-based kinematic
targets a shorter inferred travel time. A regression checks bar contact
velocity against actual displacement divided by the fixed timestep.

Rapier 0.34 skips swept checks when relative travel is less than the combined
collider thickness. Thick enclosure walls allowed deep discrete overlap during
moderate impacts. The 2 mm wall design passes impacts from 1 to 20 m/s and the
24-ball stress test. Contact prediction is 2 mm; allowed resting error is
0.2 mm. Other contact softness settings retain Rapier's defaults.

The final native 20-second stress run recorded up to 15.3 mm of transient wall
overlap (the largest relative overlap was 44.7% of a sphere radius). No ball
center crossed an enclosure boundary. All 24 balls settled within 1 mm of
non-overlap after the bars lowered. This is a numerical rigid-body model with
transient contact error. The accepted 120 Hz rule requires no escape, collapse,
or persistent overlap; it does not impose an extra transient-overlap distance.
The phone review must also assess visible contacts.

## Clocks, buffers, and cleanup

`SimulationConfig`, tick-stamped `SimulationInput`, and `SimulationSnapshot`
are independent of browser types. Snapshots contain sphere position, rotation,
radius, mass, linear/angular velocity and color, actual bar tops, 24×24 bar
contact impulses, and each sphere's total normal contact impulse in N·s.
The WASM wrapper exposes numeric arrays and the snapshot memory location.

The worker clock runs independently of render frames. Each timer processes at
most eight fixed steps. It retains elapsed time and reports outstanding delay;
it never discards simulation time to improve the FPS display. The page permits
one outstanding snapshot request, uses a three-buffer transfer pool, and limits
queued inputs to 256. Input recording preserves the source timestamp and the
tick when the simulation applied it. Exported reports replay exactly with the
same WASM build at 30, 60, and 120 render FPS.

The renderer owns the complete transfer pool and returns both snapshots on
reset. Phone acceptance also checks snapshot age and displayed tick progress;
a running worker with a frozen renderer cannot pass on frame rate alone.

One animation loop interpolates snapshots and updates the accessible audio
meters. ResizeObserver caches layout measurements. The renderer caps pixel
ratio at 2 and uses simple lighting, modest meshes, and no dynamic shadows or
bloom. Rounded bar caps use two chords per quarter-circle. Bar shaders retain
rainbow fills, full-height glow, and a one-CSS-pixel
white inner edge. Only distinct bar impacts blend sphere colors.

Hidden pages and lost WebGL contexts pause both clocks. Return resets the
frame clock. Route cleanup closes audio, terminates the worker, removes sensor
and page listeners, disconnects the observer, cancels the animation loop, and
disposes the WebGL context and resources. Async sensor permission and module
loading cannot recreate resources after cleanup.

## iPhone 16e acceptance

Use the feature preview's `/phone` page in Safari. A Mac browser or an emulated
iPhone does not establish the phone result.

1. Turn Low Power Mode off. Enter the actual iOS version in the panel.
2. Keep generated audio selected and press **Start listening**. It sends PCM
   through a MediaStream and the real AudioWorklet/loudness WASM pipeline.
3. Select **Normal view** and start the test. Keep the page visible for the
   15-second warmup and the complete five-minute measurement.
4. Confirm smooth motion only if it looked smooth. Export the JSON report.
5. Repeat in portrait fullscreen and landscape fullscreen. Rotate before
   starting each run. Use **Exit** after each fullscreen run to export it.

The report includes the Git build, device/browser details, configuration,
camera, viewport, pixel ratio, frame intervals, render submission cost,
physics step cost, recorded inputs, final state, and simulation progress.
Render cost measures CPU work through draw submission, not GPU completion.

Each run requires average FPS ≥59, p95 frame interval ≤18.5 ms, fewer than 1%
of intervals over 25 ms, no growing simulation delay, no discarded simulation
time, and the user's smooth-motion confirmation. Hidden pages, context loss,
audio stopping, view/camera changes, early completion, or report overflow
invalidate a run. A low FPS value remains visible even when physics catches up.

Keep the matching build when replaying a report:

```sh
export PATH="$PWD/.tools/bin:$PATH"
node validation/replay-physics.mjs /path/to/exported-report.json
```

Merge and Pages deployment require local checks, CI, and all three physical
phone reports to pass. The Pages job depends on every validation job and runs
only on `main`. A preview is not a production deployment.

## Local verification

Run from the repository root with pinned tools:

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py core worklet physics leptos
python3 validation/validate.py browser
```

On macOS, use host access for browser checks and keep the serial startup guard.
The final local run passed 16 native physics tests, native/WASM Clippy, pinned
Leptos validation, and 105 browser checks plus three startup harness checks.
Core and AudioWorklet validation also passed. These results do not establish
CI, physical-phone acceptance, or production deployment.

Seven Chromium layout and keyboard checks also passed in a Linux container
limited to one CPU and 3 GB RAM, with three test workers. Each layout case
allows 60 seconds for its 24 hover checks, audio checks, screenshots, and theme
changes; individual state assertions retain their five-second deadline.
