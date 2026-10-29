# Rigid-body prototype

The Leptos visualizer runs 0–16 spheres (eight by default) and 24 prescribed bars in Rapier 3D.
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
| Width / depth | 1.2 m / 0.48 m |
| Bar pitch / gap / top corner radius | 50 mm / 0 mm / 0 mm |
| Ball count / sphere diameters | Eight / original size ratios × 48 mm, mapped into the selected 2.64–19.2 cm interval |
| Density | 8 kg/m³ |
| Gravity | 9.81 m/s² |
| Ball, bar, floor and ceiling restitution / friction | 0.72 / 0.12 |
| Vertical wall restitution / friction | 0.55 minimum / 0 |
| Full-height attack / release | 40 ms attack; approximately 0.31 s gravity release; slower Reduced Motion |
| Physics rate / solver iterations | 120 Hz / 8 |
| Reserved space between paired bars | Larger of the packed stack or largest sphere + hop allowance, plus 4 mm |
| Minimum enclosure height | 0.40 m, expanded when the selected balls require more packing space |

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
with position, velocity and acceleration preserved on retargeting. Every rise
uses the configured attack duration, including quiet corrections. The default
is 40 ms; small rises no longer add a 140 ms delay. Reduced Motion attacks take
at least 320 ms. Acoustic filtering and microphone/output timing remain separate.

Releases accelerate downward at 32 bar heights/s², capped at 4 bar heights/s.
A full-height fall from rest takes about 0.31 s regardless of screen size. The
latest audio target is a hard floor: lower packets keep downward momentum,
raised floors stop the fall exactly, and identical packets never restart it.
An upward-moving bar brakes before falling. Reduced Motion retains a slower 0.5 bar heights/s² acceleration and
0.6 bar heights/s terminal speed. Reaching the floor
ends velocity and acceleration immediately, like the hat's falling envelope.
The shared loudness measurements, gain, filtering and 180 ms flash are unchanged.
While the microphone is playing, a separate travelling visual floor spans all
24 bands. Its maximum is one sixth of available bar travel. Louder audio replaces
the floor; it does not add attack flashes or direction draws. Reduced Motion
disables it. The physics worker records the combined targets for exact replay,
while the audio meters and trace retain the measured values. Protocol 10 marks
the faster release policy; older recordings need their matching engine.

Lower targets are consumed on the next outer tick. Ball load cannot slow prescribed bars, and contacts alone launch balls. On separation from a bar-driven support chain, excess outward release velocity is dissipated. The default flight budget is 30% of available enclosure space after maximum ball clearance; Reduced Motion halves it and caps it at 2.5 cm. Support propagates through stacked balls. Carrying motion is not clamped; ordinary drops, lateral/angular motion, and external forces retain their behavior. This energy limit is an animation choice, not a measured material property. The idle bar end sits 3 mm inside its active floor or ceiling base.

Large attacks from rest must arrive within 1% of a stable target within 50 ms
of physics receipt. Stable corrections up to 1% must settle within 150 ms.
Retarget reversals include braking and are tested separately.

The full pattern travels at four columns per second at 120 BPM (two columns
per beat), scaling with smoothed tempo. A qualifying new recent loud attack
permits one probability draw. At the default chance, 90% leave direction
unchanged, 5% reverse horizontal travel, and 5% change the floor/ceiling base.
Time alone never reverses measured-audio direction. Velocity eases with a
120 ms time constant; stopping uses a 120 ms smoothstep. Position stays
continuous through tempo changes and stops.
Disabling scrolling and Reduced Motion stop in place; enabling scrolling resumes there.
Stopping audio restores the independent idle wave, which obeys the same Scroll
lights switch. Hidden pages pause simulation.
Each source has three physical copies; only copies beyond the closed side walls
recycle. Copies farther than one column outside either wall are disabled in
the solver and re-enabled before they can contact a ball. Rendering clips
copies to the enclosure. The 24 accessible meters keep
source identity while their pointer regions and keyboard focus follow the bars.

The enclosure uses six half-spaces, including a real downward-facing ceiling. Each source has a 48 mm flat top with a straight 2 mm join to the next source. The closed prisms extend beyond the active floor or ceiling base. Shared edges have no buried collision walls; the renderer uses the same flat tops and joins, with one outer coating. Size-sorted initial rows fit inside the minimum enclosure without overlaps. Staggered horizontal and depth positions let stacks spread when all bars rise together. Resize preserves ball state and scales the normalized musical trajectory through a separate 300 ms enclosure transition; it never retargets music. The ceiling expands immediately, but only shrinks through vacant ball/bar clearance. The camera fits the entire transitional enclosure, and DOM guides and hit regions follow that projection.

Browser camera controls use the stable `cameraAngle`, `cameraZoom`, `cameraX` and `cameraY` parameter IDs in `physics/camera-pan.js`. Their metadata defines defaults, bounds, steps and units; `CameraParameters.set()` rejects unknown IDs, nonnumeric/nonfinite values and out-of-range values. Position is the bounded camera anchor in percent (0–100, default 50); zoom is 25–200% (default 100); angle is −40° to +40° (default 0). Manual editors step by one unit, while elapsed-time WASD movement uses continuous values through the same setter. `effective()` accepts validated temporary angle overrides for the existing sweep without changing stored manual values. This is a parameter interface for future modulation, not a modulation engine.

Zoom divides the fitted projection tangent by its percentage after fitting all eight enclosure corners. It is reapplied on animation, resize and physical-depth changes without changing enclosure measurement or worker inputs. 25% allows three or more adjacent banks in one view; enlargement may intentionally crop the room. Projection consumers (meter hit regions, pointer rays, source lighting and side-bank culling) use the resulting camera matrices. Camera readout synchronization uses a separate event from display reconfiguration; edits persist on completion and held-key movement persists on release or interruption, rather than writing storage every frame. Both position axes and zoom invalidate active phone measurements. Reduced Motion disables the sweep but permits deliberate adjustment.

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
into that fixed viewport, even with no orientation events. The expanded view's
**Rotate** button adds a fixed clockwise quarter turn to the browser screen angle.
The inverse display mapping also applies to pointer input and exit gestures;
gravity already received is remapped immediately, while shake expiry and the
depth axis remain unchanged. Returning to the normal page uses upright coordinates.
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
Independent device gravity uses input[34..36], enabled by input[37]. Protocol 12
adds audio attack edges at input[38..61] and publishes the 62-value input length
at layout[22]. SI shake magnitudes and the separate contact speed bounds stay unchanged.
The WASM wrapper exposes numeric arrays and the snapshot memory location. Protocol 21 reserves sixteen body/contact/pigment slots; `layout[21]` is capacity, and `snapshot[layout[30]]` is the active physical count. Inactive body slots are zeroed. Inputs 64–66 carry count and minimum/maximum diameters in metres; the eleven-value initial configuration ends with the same settings. The original eight-index size profile repeats deterministically for indices 8–15. Core owns the interval mapping and minimum packing height. Count changes remove actual bodies/colliders; survivors keep their handles, velocities and pigments. Size changes recompute mass/inertia and all radius-dependent calculations. When growing spheres overlap, a deterministic six-column packing preserves velocities and colors while relocating the bodies. Short rooms reserve enough height for that packing. Rendering allocates sixteen instances once, draws only active bodies, initializes new instances without interpolating from empty slots and clears inactive lighting. Count and size changes render bodies and enclosure from the same applied tick; ordinary motion interpolation resumes afterwards. Protocol 21 uses 67 held inputs and phone report v7; incompatible historical reports require their matching engine and are rejected explicitly. Geometry at `layout[17]` publishes actual ceiling, maximum bar top, hop allowance, minimum height and depth.

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
columns. At 120 BPM it travels four columns per second (two columns per beat).
Only a genuine attack that sets a new decaying recent loud peak can draw for a
direction change. The default draw gives 90% unchanged, 5% horizontal reversal,
and 5% floor/ceiling change. A saved setting changes the total chance while
keeping equal shares for both axes. No timer changes measured-audio direction.
Tempo changes integrate into the running phase. Switching scrolling off eases
to a stop in place; Reduced Motion disables automatic travel. Source colors,
contacts, accessible labels and audio data keep their source identity.

The separate tempo setter leaves the held physical input and audio transport
unchanged. The 64-value physics input contains 38 motion values, 24 current audio
attack edges, enclosure depth and the attack-only paint policy. Recording retains
those edges separately from decorative bar travel.
New reports include the random seed, starting accent
ordinal and tempo, dance settings, and tick-stamped input events with their
tempo and accent in worker application order. Phone report v6 replay applies
each input and its cue together before stepping, including inputs at the same
tick, then verifies the full snapshot and all 72 visible regional pigment values. Older report formats and physics protocols require their historical replay tool.

The fixed-memory estimator, recent-peak gate, direction policy, flight math, quadratic sphere drag,
continuous contact-color fill, and quintic bar motion are hardware-neutral
`musical-lights-core` modules, checked with `no_std` and no allocator. Rapier,
Web APIs, recording ownership and Three.js shading remain application adapters.
See [implementation and evidence](musical-motion-results/README.md).

Normal flight reserves 30% of available enclosure space after maximum ball
clearance. The slider allows 0–50%. Reduced Motion halves the flight budget and
caps it at 2.5 cm. Existing support-release limiting uses the shared core's
`sqrt(2gh)` release speed. A floor/ceiling change retracts the bars, switches
colliders outside the room, then regrows them over 500 ms. Gravity remains
measured/default gravity; ceiling bars can leave balls resting on the floor.

One animation loop interpolates snapshots and updates the accessible audio
meters. ResizeObserver caches layout measurements. The renderer caps pixel
ratio at 2 and uses simple lighting, modest meshes, and no dynamic shadows or
bloom. Bars meet edge to edge with flat tips in both the colliders and the
rendered geometry. This removes the rounded seam trough that let the smallest
sphere settle below adjacent tips. Sphere sizes remain based on 48 mm.
Physics protocol 21 starts each ball uniformly in the source color at its actual
spawn X coordinate. It rejects replays from previous engines. Physical rolling
reveals three soft swirl regions. A contact adds its bar color at the ball's
material contact point, and each visible region fills toward its own target
with a 175 ms exponential time constant (about 525 ms to 95% of a held target).
Contact injection, elapsed-time fill and spatial joins all interpolate standard
D65 HSLuv: hue in degrees, saturation/lightness in 0–100. Hue follows the shortest
circular path; exact 180° ties increase hue. An achromatic endpoint borrows its
chromatic partner's hue; two achromatic endpoints use hue zero. Saturation and
lightness never overshoot. Numerical conversion tolerance is 3e-6 linear RGB;
partitioned repeated fill allows 3e-4 accumulated linear-RGB error. Browser
conversion patches allow two 8-bit framebuffer levels; curved swirl pixels allow
eight levels against analytic ray hits because GPU varying interpolation and
trigonometry differ near steep joins. Saturation and hue continuity are also
checked independently.
Other regions retain their colors. The shared core supplies the swirl profile
for contact injection and drawing. Transport remains linear RGB. The renderer
converts each visible region to HSLuv on upload and converts the joined color
back to linear RGB once per fragment, before Three.js output encoding. There is
no RGB instance-color underlay. Lighting uses the core's ¼–½–¼ visible RGB summary,
never future contact targets. Spawn colors are preserved exactly in simulation.

The hue-path precedent is [FastLED's shortest hue gradients](https://fastled.io/docs/d1/dfb/colorutils_8h.html);
conversion uses [HSLuv reference D65 gamut bounds](https://www.hsluv.org/math/).
Core and renderer conversion checks share selected official snapshot-rev4 vectors;
`validation/fixtures/hsluv-reference.json` records source provenance and digest.
Bar shaders retain rainbow fills, full-height glow, and a 1.25-CSS-pixel
white inner edge. The flash keeps its existing 180 ms decay and Reduced Motion
intensity. In silence, distinct physical bar contacts add color. During microphone
or digital playback, only attacking bars add color; a new attack can also light
an existing resting contact. Persistent pressure or a held attack cannot keep
repainting the ball. The numeric input records this audio paint policy for replay.

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
muted lightness. Adjacent fills meet without a gap or dark outline. A narrow
white attack flash sits inside each bar boundary.
Bar height remains the loudness measure. Source labels, numeric
meters, keyboard focus and pointer readouts remain available independently of
color. LED palettes and acoustic analysis are unchanged.

## Contact pigments and lighting

Three connected color regions per ball form a soft continuous field in object
coordinates. The field rotates with the physical quaternion. A new physical
bar contact blends its source color into the target, even without music.
Visible regions fill gradually at fixed ticks instead of swapping bands.
Decorative motion alone does not paint; an actual contact must occur.
Persistent resting contacts do not change the target. Snapshots report the
visible surface mean, so lighting follows the fill instead of jumping ahead.

Bars use diffuse Lambert lighting with contiguous colored boundaries and white emissive attack
highlights. A separate colored pulse multiplies the source attack envelope by
its shared display loudness level. Physical bar travel, including the listening
floor, does not set audio brightness. Silent preview uses only its rising wave.
The saved **Colored attack light** control sets pulse strength from 0 to 3,
independently of the white **Bar attack glow** control. One bounded field of
24 paired strips and up to sixteen balls lights nearby surfaces. Hemisphere/directional fill
lights the enclosure. With Phone motion enabled, the original global rig rotates
from enclosure-up to the opposite of normalized, screen-mapped gravity. Its
upright key direction (-1, 3, 4), fill direction (2, 1, 1), colors and intensities
are preserved. This includes upside-down and face-up/down poses; moving the
camera does not redefine up. Shake acceleration is separate. Gravity retains its
SI magnitude for physics, while invalid or shorter-than-1e-6 m/s² lighting
vectors restore the upright rig. Turning motion off restores that rig immediately
without resetting bodies or contact pigments. Motion and lighting work with
Listening off, including orientation-only permission. Display quarter turns
remap cached gravity and lighting immediately, without another sensor event.
Stopping motion clears the cached vectors so later display rotation cannot
revive them. Closed views reject late gravity callbacks.

Rendering remains
instanced, without shadow maps or bloom. Frame measurements are host evidence;
physical-iPhone and human-listening acceptance remain pending.

A dark starfield sits behind the scene. One batch draws stars from the HYG 4.1
catalog at their J2000 sky positions, centered on Orion. Catalog magnitudes
control prominence; measured B-V values supply display tints. Music adds BPM
and attack shimmer without moving or recoloring stars. Reduced Motion holds
brightness steady. Stars use no textures or render targets. A single scene
pass draws foreground geometry over them.

The default enclosure is 0.48 m deep. The common **Depth** control sets 20–200 cm,
with 1 cm steps and direct numeric entry. It changes the actual front/back walls
and post depth at the next fixed physics tick. Shrinking moves balls inside the
new boundaries and removes outward velocity there. It preserves their other
motion, pigments and simulation clock. The eight side banks use the same depth.

All active physical balls are opaque and write depth. The renderer draws no
mirrored geometry or translated ball images. One faint outer coating covers
all nine banks without internal walls. Bars have their actual physical depth.
The image-count setting, Auto image trials and depth-image opacity fade are removed.

Protocol 21 retains requested depth at input[62] and applied depth at
snapshot[layout[17]+4]. The recorded input has 67 values. Replay uses the exact
engine layout and retains depth changes through deterministic playback. Saved
settings keep depth in physics[5] in meters; the common control displays cm.

A physical bar contact changes the ball's color target, with the existing
impulse/mass blend strength. Three connected surface regions fill toward that
target at fixed physics ticks, with a 0.18 s time constant per region (about
1.13 s for the last region to reach 95%). The renderer joins them with a soft
continuous gradient attached to the rolling ball. Contact does not replace
visible color bands. Repeated resting pressure does not change the target.
The visible surface mean also drives ball lighting, so it does not jump ahead
of the fill. Spawn colors still match each ball's actual X coordinate.
