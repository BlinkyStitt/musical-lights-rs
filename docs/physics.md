# Rigid-body prototype

The Leptos visualizer runs 8 spheres and 24 prescribed bars in Rapier 3D.
The display target is smooth 60 FPS; 120 FPS is optional. Physics retains a
fixed 120 Hz clock with collision substeps and no discarded simulation time.
`musical-lights-physics` contains the same simulation for native tests and WASM.
The browser runs it in a dedicated Worker, separate from the AudioWorklet.
Three.js 0.186.0 draws the actual collider transforms in one WebGL2 canvas,
using one instanced sphere mesh, one instanced bar mesh, a ceiling line, and four lit enclosure surfaces.

## Physical setup

These defaults are adjustable prototype assumptions, not measured materials.

| Setting | Default |
| --- | --- |
| Width / depth | 1.2 m / 0.24 m |
| Bar pitch / gap / top corner radius | 50 mm / 2 mm / 12 mm |
| Sphere diameter | 8 size ratios × 48 mm |
| Density | 8 kg/m³ |
| Gravity | 9.81 m/s² |
| Ball, bar, floor and ceiling restitution / friction | 0.72 / 0.12 |
| Vertical wall restitution / friction | 0.55 minimum / 0 |
| Full-height attack / release | 40 ms attack; approximately 1.13 s gravity release; slower Reduced Motion |
| Physics rate / solver iterations | 120 Hz / 8 |
| Reserved upper space | Largest sphere diameter + hop allowance + 4 mm |
| Minimum enclosure height | 0.40 m |

Rapier derives sphere mass and inertia from radius and density. It resolves
friction, angular motion, restitution, and contact impulses. Balls do not
compress, and the application does not add launch impulses.

The default is a lightweight inflated-ball proxy: restitution 0.72, friction
0.12, and angular damping 0.15. Ideal stationary-surface rebound without drag
would be 51.84% of drop height. Quadratic air drag (air density 1.225 kg/m³,
sphere drag coefficient 0.47) reduces that height and depends on size, speed,
and mass. Its implicit velocity update remains dissipative for fast launches.
These are visual prototype assumptions. Moving bars transfer momentum through
physical contacts; the measured sensor force and existing release remain.

The four vertical walls have a separate material: zero friction lets balls
slide down even while a shake presses them against a side, front, or back wall.
Their restitution is 0.55, combined with the ball's value using the maximum;
the default ball value of 0.72 therefore governs. Lowering ball restitution
retains the wall's 0.55 minimum. This is a visual tuning choice, not a measured
material. Drag and predictive soft contacts can reduce ideal rebound. A ball at rest
does not receive an artificial kick away from a wall.

Bars use position-based kinematic bodies in normalized bar coordinates.
Rises use piecewise quintic Hermite splines: 70% acceleration and 30% braking,
with position, velocity and acceleration preserved on retargeting. Upward
corrections of 1% or less take 140 ms; smoothstep interpolation reduces this to
40 ms at 12.5% or more. Reduced Motion attacks take at least 320 ms.

Releases accelerate downward at 2 bar heights/s², capped at 1.2 bar heights/s.
A full-height fall from rest takes about 1.13 s regardless of screen size. The
latest audio target is a hard floor: lower packets keep downward momentum,
raised floors stop the fall exactly, and identical packets never restart it.
An upward-moving bar brakes before falling. Reduced Motion uses one quarter
of the release acceleration and half the terminal speed. Reaching the floor
ends velocity and acceleration immediately, like the hat's falling envelope.
The shared loudness measurements, gain, filtering and 180 ms flash are unchanged.

Lower targets are consumed on the next outer tick. Ball load cannot slow prescribed bars, and contacts alone launch balls. On separation from a bar-driven support chain, excess upward release velocity is dissipated to limit extra hops to `min(0.08 * enclosure_height, 0.05 m)`, halved for Reduced Motion. Support propagates through stacked balls. Carrying motion is not clamped; ordinary drops, lateral/angular motion, and external forces retain their behavior. This energy limit is an animation choice, not a measured material property. The idle top is 3 mm above the floor.

Large attacks from rest must arrive within 1% of a stable target within 50 ms
of physics receipt. Stable corrections up to 1% must settle within 150 ms.
Retarget reversals include braking and are tested separately.

The full pattern scrolls in both directions on an eight-second sinusoidal cycle
at 120 BPM, reversing gently every four seconds. Average absolute travel is two
columns per second, scaling with the smoothed tempo; peak speed is π/2 times that
rate. Equal travel left and right removes permanent conveyor bias. A tempo-scaled
enabled-time clock preserves position through tempo changes and when stopped,
with a 120 ms smoothstep start/stop transition.
Disabling scrolling and Reduced Motion stop in place; enabling scrolling resumes there.
Stopping audio restores the independent idle wave, which obeys the same Scroll
lights switch. Hidden pages pause simulation.
Each source has three physical copies; only copies beyond the closed side walls
recycle. Copies farther than one column outside either wall are disabled in
the solver and re-enabled before they can contact a ball. Rendering clips
copies to the enclosure. The 24 accessible meters keep
source identity while their pointer regions and keyboard focus follow the bars.

The enclosure uses six half-spaces, including a real downward-facing ceiling. Each rounded bar extends 20 m below its top. Size-sorted initial rows fit inside the minimum enclosure without overlaps. Staggered horizontal and depth positions let stacks spread when all bars rise together. Resize preserves ball state and scales the normalized musical trajectory through a separate 300 ms enclosure transition; it never retargets music. The ceiling expands immediately, but only shrinks through vacant ball/bar clearance. The camera fits the entire transitional enclosure, and DOM guides and hit regions follow that projection.

Pointer interaction is a radial acceleration field within 0.22 m, with a
maximum strength of 15 m/s². Device linear acceleration already arrives in
m/s²; all three axes contribute, including shaking into or out of the screen.
The renderer preserves measured acceleration at 1:1, without an amplification
factor or a per-axis magnitude clamp. Non-finite readings are rejected. A
2 m/s² shake applies 2 m/s²; an upward shake must overcome real gravity to lift
a resting ball.
Screen rotation maps the two in-plane axes; the opposite acceleration is
applied to the balls, as if shaking their enclosure. Gravity is a separate 3D
vector, preserving the measured magnitude. iOS WebKit exposes
[CoreMotion's user acceleration plus gravity](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/WebCoreMotionManager.mm),
so gravity is the gravity-inclusive reading
minus linear acceleration. Other browsers expose support acceleration and
use the opposite difference. iPhone/iPad detection includes iPadOS desktop
mode. This sign correction applies only to gravity; shake readings retain
their existing inertial mapping. Orientation-only devices use the full beta/gamma
rotation of 9.81 m/s² gravity. Upside down reverses the screen's vertical pull;
flat face-up pulls into the back of the box, and face-down toward the front.
The screen-plane projection is never normalized, so near-flat sensor noise
cannot turn into a full-strength sideways pull. Measured gravity takes priority
over orientation while motion readings are fresh (500 ms).
The simulation applies force as mass × acceleration each tick. Reduced Motion
scales shake/pointer acceleration to 10% and uses the configured slower stroke
time, while gravity keeps its physical magnitude. Disabling motion restores
the default downward gravity.

The **Phone motion** switch requests motion and tilt permissions independently
of Listening. A pending tilt request cannot block granted acceleration access.
The switch tracks actual listeners, including tilt-only sessions, and pending
permission can be canceled. Turning Phone motion off clears sensor forces and
invalidates pending grants while musical targets continue. Turning Listening
off releases audio capture and starts the silent sine preview while sensors
continue. Leaving the page closes both sessions and the preview. Display rotation
lock never gates accelerometer delivery: a fixed screen angle still maps shakes
into that fixed viewport, even with no orientation events.
When linear acceleration is unavailable, a 250 ms exponential baseline removes
the slow gravity component from gravity-inclusive readings; the baseline
also supplies gravity with the same platform sign correction. This fallback is
an approximation: fast rotations can also appear as shakes. Its first reading,
restart, and gaps of at least 500 ms establish a fresh baseline without a kick.
Shake forces expire 150 ms after the last usable reading. Sensor semantics
follow the [Device Orientation and Motion specification](https://www.w3.org/TR/orientation-event/).

The microphone permission notice and idle motion status query browser permissions
without requesting access. They distinguish allowed, prompt, blocked, unknown,
unavailable APIs, and insecure pages. Unsupported or rejected permission queries
remain unknown and do not prevent a user-initiated start. Microphone acquisition
and granted motion requests update the current visit's status; usable sensor
readings also confirm motion access. Permission status stays separate from the
microphone on/off indicator and enabled motion listeners. A dismissed microphone
prompt reports that access was not granted, without claiming a permanent denial.

Permission changes, window focus, visible-page returns, and `pageshow` refresh the
display. Route cleanup removes permission observers and ignores late query or
capture results. No permission is persisted in storage or inferred from a bookmark
or Home Screen launch: the browser remains authoritative. The expandable access
help explains site settings and potentially separate browser/Home Screen grants.
These checks follow the [Permissions API](https://w3c.github.io/permissions/)
and [media capture permission semantics](https://w3c.github.io/mediacapture-main/#permissions-integration).

Physical-phone motion acceptance remains a separate check: after turning on Phone motion
and allowing access, try left/right, up/down, and toward/away shakes in
portrait and landscape. Repeat with music driving the bars; both sources must
move the balls together. Hold still to check that shaking stops, then turn off Phone motion
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

The travel bound uses the larger of two opposing spheres' speed and a sphere
plus a nearby post's speed, rather than adding three bodies' speeds for a
two-body contact. This reduces redundant solves without changing bar targets,
40 ms full-stroke travel, contact iterations, or the work cap. Extreme fullscreen
attacks can still reach the cap; their warning remains visible.

Post speeds contribute to this bound only where their swept region can reach
a sphere during the tick. The region includes lateral travel, vertical travel,
sphere velocity, applied acceleration and contact prediction distance. Empty
space strokes still advance on every tick. Collider source tags and bit masks
propagate stack support without scanning every collider or a full ball-to-ball matrix for
each contact substep. Worker timing artifacts retain each batch's total and
maximum substeps alongside execution time and scheduling delay.
Worker batches yield after eight ticks or one tick's worth of execution time,
whichever comes first. An individual tick remains indivisible, and overdue
work continues immediately after yielding without dropping simulation time.

Substep count, excess requested substeps, maximum speed, acceleration limit, and all 24 bar velocities are included in snapshots. Worker reports include per-tick substeps and CPU cost, maximum substeps, overload ticks, and retained simulation delay. Hitting the cap is visible; no elapsed time is dropped. Contact prediction remains 2 mm, allowed resting error 0.2 mm, and ordinary contact natural frequency 60 Hz. While a sphere is predictively near the ceiling, contact natural frequency is 240 Hz with eight positional stabilization passes per force-solver iteration, instead of one. There are still eight force-solver iterations. This prevents visible ceiling compression without changing ordinary elastic collisions. The CCD minimum interval is scaled below the smallest contact substep.

The [current source-band and stroke report](partial-loudness-results/README.md) records the current stress and timing results. Tests cover ceiling rebound, full-stroke stack compression, release hops, and persistent overlap after settling. The ceiling replaces the former open top.
The [device gravity and fullscreen work report](device-gravity-results/README.md)
records the protocol 7 sensor checks and before/after solver measurements.

Settled spheres can rest on other spheres. The stress test requires an active
contact path down to the floor or lowered bars for each sphere, as well as
the existing velocity and overlap limits.

## Clocks, buffers, and cleanup

`SimulationConfig`, tick-stamped `SimulationInput`, and `SimulationSnapshot`
are independent of browser types. Snapshots contain sphere position, rotation,
radius, mass, linear/angular velocity and color, actual bar tops, 8×24 bar
contact impulses, and each sphere's total normal contact impulse in N·s.
Protocol 7 adds independent device gravity at input[34..36], enabled by
input[37], and publishes the 38-value input length at layout[22]. It also
preserves SI shake magnitudes and uses the separate contact speed bounds above.
The WASM wrapper exposes numeric arrays and the snapshot memory location. Protocol 6 changes the engine to gravity release and balanced scrolling; historical replays require their matching engine. Protocol 5 separates the 24 source bands in `layout[0]` from the 8 balls in `layout[21]`, with compact body and contact arrays. The ball count stays constant across normal and fullscreen views, so resizing never removes or respawns bodies. Protocol 4 replaces input[33] with scrolling enablement and publishes continuous phase at the snapshot offset in layout[20]. Geometry layout v2 adds an offset at layout[17] for actual ceiling height, maximum bar top, hop allowance, and minimum height. Reports use this geometry rather than the former fixed 5% headroom assumption. Replaying historical physics requires its matching engine; mismatched layouts are rejected explicitly.

The worker clock runs independently of render frames. Each batch processes at
most eight fixed steps. Overdue batches yield through MessageChannel without a
nested timer delay. It retains elapsed time and reports outstanding delay;
it never discards simulation time to improve the FPS display. The page permits
one outstanding snapshot request and returns the next buffer immediately on
receipt, independently of animation-frame callbacks. The worker publishes at
most once per two simulation ticks (60 Hz), so a delayed render cannot starve
the view of fresh state and a stalled main thread cannot accumulate snapshots.
The page uses a three-buffer transfer pool and limits queued inputs to 256. Input recording preserves the source timestamp and the
tick when the simulation applied it. Exported reports replay exactly with the
same WASM build at 30, 60, and 120 render FPS.

The renderer owns the complete transfer pool and returns both snapshots on
reset. Phone acceptance also checks snapshot age and displayed tick progress;
a running worker with a frozen renderer cannot pass on frame rate alone.

**Scroll lights** now continuously translates the collider/visual source
columns. At 120 BPM it averages two columns per second of absolute travel, with
balanced smooth reversals every four seconds of tempo-scaled enabled time.
Tempo changes integrate into the running phase. Switching scrolling off eases
to a stop in place; Reduced Motion disables automatic travel. Source colors,
contacts, accessible labels and audio data keep their source identity.

The separate tempo setter leaves the 38-value held input and 99-value audio
transport unchanged. Recording optionally includes tick-stamped `tempoEvents`;
replay applies them before stepping. Historical reports without those events
use 120 BPM and still require their matching historical engine.

The fixed-memory estimator, scrolling oscillator, quadratic sphere drag,
contact-pigment history, and quintic bar motion are hardware-neutral
`musical-lights-core` modules, checked with `no_std` and no allocator. Rapier,
Web APIs, recording ownership and Three.js shading remain application adapters.
See [implementation and evidence](musical-motion-results/README.md).

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

Use the `/advanced` page in Safari. A Mac browser or an emulated
iPhone does not establish the phone result.

The FPS display counts actual animation-frame intervals. The app has no 30 FPS
limit. WebKit intentionally limits animation to 30 FPS in Low Power Mode; see
the [WebKit explanation](https://bugs.webkit.org/show_bug.cgi?id=215745).
If the phone stays near 30 FPS, first check that Low Power Mode is off and Safari
is in the foreground. If it remains slow, compare normal and fullscreen views
and export timing data. A 30-second run ended early can help diagnose frame
intervals, render cost, and physics delay; it is not a five-minute acceptance
result. Do not infer a phone performance improvement from a Mac measurement.

1. Turn Low Power Mode off. Enter the actual model, browser and iOS version.
2. Select Test tones and click **Play audio**. It sends PCM
   directly through the real AudioWorklet/loudness WASM pipeline. Keep Repeat
   on and Diagnostic recording off; digital review files do not qualify.
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
phone reports to pass. The Pages job depends on core, web and loudness-reference
validation and runs only on `main`. A preview is not a production deployment.

## Local verification

Run from the repository root with pinned tools:

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py core worklet physics leptos
python3 validation/validate.py browser
```

On macOS, use host access for browser checks and keep the serial startup guard.
The earlier scrolling and flash update passed 50 core tests in each of four feature
configurations, 31 native physics tests, native/WASM Clippy, pinned worklet and
Leptos validation, and 190 browser checks plus 10 harness checks.
These results do not establish CI, physical-phone acceptance, or production
deployment.

Seven Chromium layout and keyboard checks also passed in a Linux container
limited to one CPU and 3 GB RAM, with three test workers. Each layout case
allows 60 seconds for its 24 hover checks, audio checks, screenshots, and theme
changes; individual state assertions retain their five-second deadline.

Phone acceptance requires an actively playing, repeating 24-tone exercise with diagnostics off. A session replacement, pause, natural end, interruption, cleanup, or repeat-off invalidates warmup and measurement immediately. Resume does not remove invalid reasons. The generated exercise is normalized to unit peak before applying the selected amplitude; its changing pattern is preserved.

## Rainbow

The browser keeps the established red-to-purple HSLuv hue anchors, uses full
saturation, and scales each linear RGB fill until its brightest channel reaches
one. This uses the full display gamut instead of holding every hue at the same
muted lightness. A permanent one-pixel dark outline separates bright fills
from the light background; the one-pixel white attack flash sits just inside it.
Bar height remains the loudness measure. Source labels, numeric
meters, keyboard focus and pointer readouts remain available independently of
color. LED palettes and acoustic analysis are unchanged.

## Contact pigments and lighting

Three recent contact pigments per ball drive a smooth procedural pattern in
object coordinates. Its appearance rotates with the physical quaternion;
Reduced Motion stops additional pattern drift. Existing average-color snapshot
diagnostics stay intact, and resting contacts do not keep adding pigments.

Bars use diffuse Lambert lighting with a dark boundary and white emissive attack
highlights. Four reusable point lights illuminate nearby surfaces during attacks,
with hemisphere/directional fill and lit enclosure surfaces. Rendering remains
instanced, without shadow maps or bloom. Frame measurements are host evidence;
physical-iPhone and human-listening acceptance remain pending.
