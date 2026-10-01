# Device gravity and fullscreen solver work

Measured on 2026-10-01. Motion uses browser acceleration in m/s² at 1:1, with
independent 3D gravity. The old 8× shake gain, ±100 m/s² clamp, and additive
2 m/s² tilt field are removed. Orientation fallback rotates Earth gravity into
the phone frame; it does not normalize the screen projection. Flat face-up
gravity points toward the box's back, and upside down reverses vertical pull.

When both acceleration fields are available, gravity is linear acceleration
minus gravity-inclusive acceleration, retaining measured magnitude. When only
gravity-inclusive readings exist, the existing 250 ms baseline estimates the
gravity/translation split. That fallback cannot distinguish fast rotations
from translation perfectly. No extra smoothing is applied to measured gravity.

## Computation measurements

`validation/physics-cost.mjs` runs the actual release WASM with the same
generated PCM, resizing sequence, 1,440 ticks, and three runs per engine on an
Apple M4 Max with Node 26.8.2. [Before](before.json) and [after](after.json)
include WASM/PCM hashes and full attack traces. The before engine already has
the gravity changes; the only engine difference is the collision travel bound.

| Measurement | Before | After |
| --- | ---: | ---: |
| Total substeps in each 12-second run | 21,721 | 15,398 |
| Median CPU time | 731.41 ms | 514.90 ms |
| Normal-height full attack: maximum requested substeps | 128 | 86 |
| Fullscreen full attack: maximum requested substeps | 437 | 293 |
| Fullscreen full attack: capped ticks | 4 | 3 |

The solver uses `max(2 × ball speed, ball speed + nearby post speed)` instead
of adding all three speeds. This bounds both types of two-body contact while
avoiding redundant substeps. This workload used 29.1% fewer substeps and about
29.6% less CPU time. These are host measurements, not iPhone timings.

Audio analysis, target heights, 40 ms travel, eight solver iterations, and the
128-substep cap are unchanged. The extreme fullscreen attack still reaches
the cap and still reports it. No simulation time is dropped. Both builds reach
the full attack target on the fifth 120 Hz tick (41.67 ms); full traces retain
intermediate positions and velocities for comparison.

## Validation scope

Local validation passed: 42 Rust physics tests, native/WASM Clippy, the Leptos
validation target, 24 Node harness tests, and all 264 Chromium/WebKit checks.
Browser validation used macOS host access, the serial startup guard, one worker,
and zero retries. The iPhone WebKit profile passed fullscreen transition,
live-audio continuity, simulation-delay, and direct bookmark permission checks.

Rust checks cover ballistic gravity along the vertical and depth axes, wake-up
on gravity reversal, restoring default gravity, and ceiling containment during
simultaneous attacks, including the 2.596923 m fullscreen height. Node checks
cover cardinal/mixed orientations, near-flat behavior, sensor source priority,
and unchanged measured SI magnitudes.

Browser checks use Chromium's native virtual accelerometer and linear
acceleration sensors together, with coherent gravity-inclusive readings.
Browser-delivered events reach the production worker and real WASM: upside-down
balls rise into the upper half of the box; flat face-up balls reach its back.
These checks do not replace a physical iPhone test. Synthetic event tests remain
limited to input mapping and lifecycle behavior, not evidence of browser grants.
