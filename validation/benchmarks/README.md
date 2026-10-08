# Production benchmarks

Run from the repository root with the pinned compiler:

```sh
cargo +nightly-2026-09-10 bench --locked --manifest-path validation/benchmarks/Cargo.toml --bench production -- --save-baseline before
# After a measured candidate change:
cargo +nightly-2026-09-10 bench --locked --manifest-path validation/benchmarks/Cargo.toml --bench production -- --baseline before
```

Criterion uses 20 samples, one second of warmup, and at least three seconds of
measurement per case. Input construction stays outside the timed region.
This separate package keeps Criterion and its host dependencies out of the
core's embedded feature matrix and production packages.

The audio cases call the actual worklet processor through its exported API,
with contiguous 128-sample input blocks. They include input copies, ISO and
partial loudness, display filtering, novelty and tempo. One case also copies
and parses the production snapshot every second callback, matching the
240 Hz send threshold with 128-sample quanta. Diagnostics stay off. The
fixture repeats exactly two seconds of 80 Hz percussion and a 1 kHz tone.
The processor warms for six seconds and retains its continuous sample clock.

Physics cases replay 240 ticks at 120 Hz through the production Rapier
simulation. Their 24 filtered targets come from that same audio processor.
Portrait and landscape cases include scrolling, full-depth paired colliders,
eight balls and snapshot reads. The full-attack case exercises all bands in
the tall portrait enclosure. Setup and one second of settling are excluded
from the reported time. Each workload checks the substep-overload field
before benchmarking; an overloaded run is a failure, not a speed result.
The tempo case measures eight seconds of production novelty-envelope updates
after the estimator has acquired its fixed history.

These are native CPU measurements. They do not measure WASM, browser worker
queues, WebGL, GPU presentation, end-to-end audio latency or physical-phone
FPS. Use `validation/physics-cost.mjs` for the produced physics WASM and
`validation/measure-spectrum.mjs` for the actual served app with synthetic
capture through its real audio worklet. Do not run those browser measurements
beside compilation, native benchmarks or another browser runner.

For a native stack profile on macOS, use `sample` on the benchmark binary
printed by Cargo. Run the binary with `--bench` and a selected case, such as
`production_physics/music_portrait --profile-time 20`. Without `--bench`,
Criterion runs its smoke checks instead of the timed workload. Store profiles
and result logs outside Git. Record the compiler, features, hardware, workload
and measurement boundary with each comparison.
