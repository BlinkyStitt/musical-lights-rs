# Rigid-body prototype

The Leptos visualizer runs 24 spheres and 24 prescribed bars in Rapier 3D.
`musical-lights-physics` contains the same simulation for native tests and WASM.
The browser runs it in a dedicated Worker, separate from the AudioWorklet.
Three.js 0.186.0 draws the actual collider transforms in one WebGL2 canvas,
using one instanced sphere mesh, one instanced bar mesh, and a ceiling line.

## Physical setup

These defaults are adjustable prototype assumptions, not measured materials.

| Setting | Default |
| --- | --- |
| Width / depth | 1.2 m / 0.24 m |
| Bar pitch / gap / top corner radius | 50 mm / 2 mm / 12 mm |
| Sphere diameter | Original 24 size ratios × 48 mm |
| Density | 1,100 kg/m³ |
| Gravity | 9.81 m/s² |
| Ball, bar, floor and ceiling restitution / friction | 0.15 / 0.20 |
| Vertical wall restitution / friction | 0.55 minimum / 0 |
| Full-height rest-to-rest stroke | 40 ms in either direction; 320 ms Reduced Motion |
| Physics rate / solver iterations | 120 Hz / 8 |
| Reserved upper space | Largest sphere diameter + hop allowance + 4 mm |
| Minimum enclosure height | 0.40 m |

Rapier derives sphere mass and inertia from radius and density. It resolves
friction, angular motion, restitution, and contact impulses. Balls do not
compress, and the application does not add launch impulses.

The default restitution is 0.15. For a stationary surface, the ideal rebound
height is 2.25% of the drop height, down from 30.25% at the previous 0.55.
This reduces repeated bouncing while retaining the 40 ms bar stroke. Moving
bars still transfer their motion through physical contacts.

The four vertical walls have a separate material: zero friction lets balls
slide down even while a shake presses them against a side, front, or back wall.
Their restitution is 0.55, combined with the ball's value using the maximum;
the wall therefore returns more of an impact's normal speed without adding
energy. This is a visual tuning choice, not a measured material. Rapier's
predictive soft contacts can return less than the ideal 55%. A ball at rest
does not receive an artificial kick away from a wall.

Bars use position-based kinematic bodies driven by piecewise quintic Hermite
splines in normalized bar coordinates. Position, velocity and acceleration are
continuous when retargeted. From rest, 70% of the duration accelerates and the
last 30% brakes to exactly zero velocity and acceleration. Corrections of 1%
or less take 140 ms; smoothstep interpolation reduces that to 40 ms at 12.5%
(one of eight hat LEDs) or more. Reduced Motion takes at least 320 ms. Reversal
adds a braking segment; repeated identical packets do not restart a stroke.
The shared loudness measurements, gain, filtering and 180 ms flash are unchanged.

Lower targets are consumed on the next outer tick. Ball load cannot slow prescribed bars, and contacts alone launch balls. On separation from a bar-driven support chain, excess upward release velocity is dissipated to limit extra hops to `min(0.08 * enclosure_height, 0.05 m)`, halved for Reduced Motion. Support propagates through stacked balls. Carrying motion is not clamped; ordinary drops, lateral/angular motion, and external forces retain their behavior. This energy limit is an animation choice, not a measured material property. The idle top is 3 mm above the floor.

Large strokes from rest must arrive within 1% of a stable target within 50 ms
of physics receipt. Stable corrections up to 1% must settle within 150 ms.
Retarget reversals include braking and are tested separately.

The full pattern travels right at 55.5 / 80 columns per second, with a 120 ms
smoothstep speed transition. Stop, disabling scrolling, and Reduced Motion
stop in place; enabling scrolling resumes there. Hidden pages pause simulation.
Each source has three physical copies; only copies beyond the closed side walls
recycle. Rendering clips copies to the enclosure. The 24 accessible meters keep
source identity while their pointer regions and keyboard focus follow the bars.

The enclosure uses six half-spaces, including a real downward-facing ceiling. Each rounded bar extends 20 m below its top. Size-sorted initial rows fit inside the minimum enclosure without overlaps. Staggered horizontal and depth positions let stacks spread when all bars rise together. Resize preserves ball state and scales the normalized musical trajectory through a separate 300 ms enclosure transition; it never retargets music. The ceiling expands immediately, but only shrinks through vacant ball/bar clearance. The camera fits the entire transitional enclosure, and DOM guides and hit regions follow that projection.

Pointer interaction is a radial acceleration field within 0.22 m, with a
maximum strength of 15 m/s². Device linear acceleration already arrives in
m/s²; all three axes contribute, including shaking into or out of the screen.
Screen rotation maps the two in-plane axes; the opposite acceleration is
applied to the balls, as if shaking their enclosure. Tilt adds a field of up to
2 m/s² per axis. The simulation applies force as mass × acceleration each tick.
Reduced Motion scales external acceleration to 10% and uses the configured slower stroke time.

Motion and tilt permissions are requested from the Start listening click and
enabled independently, so a pending tilt request cannot block granted motion
access. Stop and route cleanup invalidate both requests and remove listeners.
When linear acceleration is unavailable, a 250 ms exponential baseline removes
the slow gravity component from gravity-inclusive readings. This fallback is
an approximation: fast rotations can also appear as shakes. Its first reading,
restart, and gaps of at least 500 ms establish a fresh baseline without a kick.
Shake forces expire 150 ms after the last usable reading. Sensor semantics
follow the [Device Orientation and Motion specification](https://www.w3.org/TR/orientation-event/).

Physical-phone motion acceptance remains a separate check: after Start listening
and allowing motion access, try left/right, up/down, and toward/away shakes in
portrait and landscape. Repeat with music driving the bars; both sources must
move the balls together. Hold still to check that shaking stops, then press Stop
to check that sensor forces stop while gravity continues. Side impacts should
rebound, and balls pressed against vertical walls should still fall when they
have no support underneath. Synthetic browser events do not verify the phone's
actual sensors or permission prompts.

## Engine selection and limits

The prototype started with Rapier 0.35.3. Its bullet CCD excludes other bullet
bodies. A native regression with two equal spheres at opposing 20 m/s speeds
reproduced tunneling. The single active dependency is therefore pinned to
Rapier 0.34.0 with enhanced determinism and CCD on every sphere.

Sphere CCD uses one internal CCD step. Each 120 Hz outer tick adds deterministic contact substeps based on sphere and bar travel, bounded at 128. Every contact substep retains eight solver iterations and its own kinematic target. Contact impulses accumulate over the whole outer tick. The controller uses no wall-clock feedback, so replay is independent of render rate.

Substep count, excess requested substeps, maximum speed, acceleration limit, and all 24 bar velocities are included in snapshots. Worker reports include per-tick substeps and CPU cost, maximum substeps, overload ticks, and retained simulation delay. Hitting the cap is visible; no elapsed time is dropped. Contact prediction remains 2 mm, allowed resting error 0.2 mm, and ordinary contact natural frequency 60 Hz. While a sphere is predictively near the ceiling, contact natural frequency is 240 Hz with eight positional stabilization passes per force-solver iteration, instead of one. There are still eight force-solver iterations. This prevents visible ceiling compression without changing ordinary elastic collisions. The CCD minimum interval is scaled below the smallest contact substep.

The [current source-band and stroke report](partial-loudness-results/README.md) records the current stress and timing results. Tests cover ceiling rebound, full-stroke stack compression, release hops, and persistent overlap after settling. The ceiling replaces the former open top.

Settled spheres can rest on other spheres. The stress test requires an active
contact path down to the floor or lowered bars for each sphere, as well as
the existing velocity and overlap limits.

## Clocks, buffers, and cleanup

`SimulationConfig`, tick-stamped `SimulationInput`, and `SimulationSnapshot`
are independent of browser types. Snapshots contain sphere position, rotation,
radius, mass, linear/angular velocity and color, actual bar tops, 24×24 bar
contact impulses, and each sphere's total normal contact impulse in N·s.
The WASM wrapper exposes numeric arrays and the snapshot memory location. Protocol 4 replaces input[33] with scrolling enablement and publishes continuous phase at the snapshot offset in layout[20]. Geometry layout v2 adds an offset at layout[17] for actual ceiling height, maximum bar top, hop allowance, and minimum height. Reports use this geometry rather than the former fixed 5% headroom assumption. Replaying historical physics requires its matching engine; mismatched layouts are rejected explicitly.

The worker clock runs independently of render frames. Each batch processes at
most eight fixed steps. Overdue batches yield through MessageChannel without a
nested timer delay. It retains elapsed time and reports outstanding delay;
it never discards simulation time to improve the FPS display. The page permits
one outstanding snapshot request, uses a three-buffer transfer pool, and limits
queued inputs to 256. Input recording preserves the source timestamp and the
tick when the simulation applied it. Exported reports replay exactly with the
same WASM build at 30, 60, and 120 render FPS.

The renderer owns the complete transfer pool and returns both snapshots on
reset. Phone acceptance also checks snapshot age and displayed tick progress;
a running worker with a frozen renderer cannot pass on frame rate alone.

The browser's **Scroll lights** setting rotates complete source bands to the
right at the hat's approximately 1.44-second column cadence. Fixed bar colliders
receive the newly assigned height through their existing motion controller;
balls remain in the same enclosure and collide with those real bar positions.
The input's source offset also selects the visible bar color for impact blends.
Scroll changes do not create attacks or modify measured loudness. The clock
pauses while hidden and resets when listening stops; Reduced Motion and the
unchecked toggle use the original fixed source order.

Physics layout version 3 retains the geometry offsets and adds a 34th input
value: the whole-column source offset (0–23). Replay records this alongside the
physical target heights. Older reports require their matching engine. Tone
diagnostics retain canonical source-band measurements and identify the requested
offset beside each physical target sample.

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

The FPS display counts actual animation-frame intervals. The app has no 30 FPS
limit. WebKit intentionally limits animation to 30 FPS in Low Power Mode; see
the [WebKit explanation](https://bugs.webkit.org/show_bug.cgi?id=215745).
If the phone stays near 30 FPS, first check that Low Power Mode is off and Safari
is in the foreground. If it remains slow, compare normal and fullscreen views
and export timing data. A 30-second run ended early can help diagnose frame
intervals, render cost, and physics delay; it is not a five-minute acceptance
result. Do not infer a phone performance improvement from a Mac measurement.

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
The scrolling and flash update passed 50 core tests in each of four feature
configurations, 31 native physics tests, native/WASM Clippy, pinned worklet and
Leptos validation, and 190 browser checks plus 10 harness checks.
These results do not establish CI, physical-phone acceptance, or production
deployment.

Seven Chromium layout and keyboard checks also passed in a Linux container
limited to one CPU and 3 GB RAM, with three test workers. Each layout case
allows 60 seconds for its 24 hover checks, audio checks, screenshots, and theme
changes; individual state assertions retain their five-second deadline.

Phone acceptance requires an actively playing, repeating 24-tone exercise with diagnostics off. A session replacement, pause, natural end, interruption, cleanup, or repeat-off invalidates warmup and measurement immediately. Resume does not remove invalid reasons. The generated exercise is normalized to unit peak before applying the selected amplitude; its changing pattern is preserved.
