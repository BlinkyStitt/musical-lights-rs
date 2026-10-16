use super::*;

fn surface_clearance(sim: &Simulation, collider: ColliderHandle, point: Vector) -> f32 {
    // Exact distance to the extruded quadrilateral. Convex support-map point
    // projection can choose an adjacent face at a thin prism's boundary.
    let collider = &sim.world.colliders[collider];
    let points = collider.shape().as_shape::<RampPrism>().unwrap().points();
    let vertices: [Vector; 4] = std::array::from_fn(|i| collider.position() * points[i]);
    let mut low = vertices
        .into_iter()
        .fold(Vector::splat(f32::INFINITY), Vector::min);
    let mut high = vertices
        .into_iter()
        .fold(Vector::splat(f32::NEG_INFINITY), Vector::max);
    low.z = -sim.config.depth / 2.0;
    high.z = sim.config.depth / 2.0;
    let bound = (low - point).max(point - high).max(Vector::ZERO).length();
    // An enclosing-box distance is a lower bound. Far prisms cannot violate
    // either the centre-containment check or the one-millimetre settling limit.
    if bound > radius(0) {
        return bound;
    }
    let p = Vector::new(point.x, point.y, 0.0);
    let mut distance = f32::INFINITY;
    let mut positive = false;
    let mut negative = false;
    for i in 0..4 {
        let a = Vector::new(vertices[i].x, vertices[i].y, 0.0);
        let b = Vector::new(vertices[(i + 1) % 4].x, vertices[(i + 1) % 4].y, 0.0);
        let edge = b - a;
        let delta = p - a;
        let cross = edge.x * delta.y - edge.y * delta.x;
        positive |= cross > 0.0;
        negative |= cross < 0.0;
        let nearest = a + edge * (delta.dot(edge) / edge.length_squared()).clamp(0.0, 1.0);
        distance = distance.min((p - nearest).length());
    }
    let xy = if positive && negative {
        distance
    } else {
        -distance
    };
    let z = point.z.abs() - sim.config.depth / 2.0;
    (xy.max(0.0).powi(2) + z.max(0.0).powi(2)).sqrt() + xy.max(z).min(0.0)
}

fn world(config: SimulationConfig) -> Simulation {
    Simulation::new(config, std::array::from_fn(|i| [i as f32 / 24.0, 0.2, 0.8])).unwrap()
}
fn isolate(sim: &mut Simulation, indices: &[usize]) {
    for (i, &(body, _)) in sim.balls.iter().enumerate() {
        sim.world.bodies[body].set_enabled(indices.contains(&i));
    }
}
fn place(sim: &mut Simulation, i: usize, p: Vector, v: Vector) {
    let body = &mut sim.world.bodies[sim.balls[i].0];
    body.set_translation(p, true);
    body.set_linvel(v, true);
    body.set_angvel(Vector::ZERO, true);
}
fn position(sim: &Simulation, i: usize) -> Vector {
    sim.world.bodies[sim.balls[i].0].translation()
}
fn velocity(sim: &Simulation, i: usize) -> Vector {
    sim.world.bodies[sim.balls[i].0].linvel()
}
fn radius(i: usize) -> f32 {
    SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0
}

fn target_color(sim: &Simulation, ball: usize) -> [f32; 3] {
    pigment_color(
        sim.color_targets[ball * 9..ball * 9 + 9]
            .try_into()
            .unwrap(),
    )
}

// Ball 0 starts at source 6. Contact lights its local swirl regions gradually;
// it must not replace a visible pigment slot or add an unrelated source color.
fn assert_first_ball_fills_toward_source(sim: &Simulation, source: usize) {
    let initial = sim.palette[6];
    let target = target_color(sim, 0);
    assert!(target[0] > initial[0] && target[0] < sim.palette[source][0]);
    for (c, &start) in initial.iter().enumerate() {
        for region in 0..3 {
            let value = sim.pigments[region * 3 + c];
            assert!(value >= start.min(sim.palette[source][c]) - 1e-6);
            assert!(value <= start.max(sim.palette[source][c]) + 1e-6);
        }
    }
    assert_eq!(
        &sim.snapshot.values[18..21],
        &pigment_color(sim.pigments[..9].try_into().unwrap())
    );
}

#[test]
fn changing_ramp_length_preserves_material_horizontal_velocity() {
    for end in [0, 1] {
        for (new_left, new_right) in [(0.2, 0.9), (0.4, 0.7)] {
            let dt = DT / 16.0;
            let old = surface_segment(0.5, 0.2, 0.7, end, 2.0, 0.24, PITCH);
            let next = surface_segment(0.5, new_left, new_right, end, 2.0, 0.24, PITCH);
            let rigid = RigidBodyPosition {
                position: old.pose,
                next_position: next.pose,
            }
            .interpolate_velocity(1.0 / dt, Vector::ZERO);
            let sign = if end == 0 { 1.0 } else { -1.0 };
            let left_speed = sign * (new_left - 0.2) / dt;
            let right_speed = sign * (new_right - 0.7) / dt;
            for fraction in [0.0, 0.37, 1.0] {
                let mut body = RigidBodyBuilder::kinematic_position_based()
                    .pose(old.pose)
                    .build();
                body.set_next_kinematic_position(next.pose);
                let (left, right) = material_endpoints(&body, PITCH);
                assert!((right.x - left.x - PITCH).abs() < 1e-6);
                let point = left + (right - left) * fraction;
                let flow =
                    ramp_surface_flow(&body, point, right_speed - left_speed, 1.0 / dt, PITCH);
                let expected_y = left_speed * (1.0 - fraction) + right_speed * fraction;
                let velocity = rigid.velocity_at_point(point, left) + flow;
                assert!(
                    velocity.x.abs() < 1e-5,
                    "stationary material moved horizontally: {velocity:?}"
                );
                assert!(
                    (velocity.y - expected_y).abs() < 0.003,
                    "wrong material rise: {velocity:?}"
                );
                // Match the published kinematic frame after integration. Release
                // eligibility must use the same material motion as the solver.
                let integrated = RigidBodyBuilder::kinematic_position_based()
                    .pose(next.pose)
                    .linvel(rigid.linvel)
                    .angvel(rigid.angvel)
                    .build();
                let contact_velocity = ramp_contact_velocity(&integrated, point, flow, dt);
                assert!(
                    (contact_velocity - velocity).length() < 0.003,
                    "solver and release eligibility disagree: {contact_velocity:?} vs {velocity:?}"
                );
            }
        }
    }
}

#[test]
fn a_symmetric_rising_peak_has_no_lateral_launch() {
    let mut sim = world(SimulationConfig {
        height: 1.2,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(12.5 * PITCH, BASELINE + radius(0), 0.0),
        Vector::ZERO,
    );
    let mut levels = [0.0; COUNT];
    levels[12] = 1.0;
    input(&mut sim, levels);
    sim.step();
    assert!(
        velocity(&sim, 0).x.abs() < 0.001,
        "symmetric peak launched sideways: {:?}",
        velocity(&sim, 0)
    );
    assert!(
        position(&sim, 0).y > BASELINE + radius(0),
        "peak did not lift the ball"
    );
}

#[test]
fn passive_flat_joins_cannot_accelerate_or_bump_a_rolling_ball() {
    for roof in [false, true] {
        let mut sim = world(SimulationConfig::default());
        isolate(&mut sim, &[0]);
        input(&mut sim, [0.15; COUNT]);
        for _ in 0..HZ {
            sim.step();
        }
        let top = sim.bar_positions[0] as f32;
        let inward = if roof { -1.0 } else { 1.0 };
        let y = if roof {
            sim.ceiling_height - top - radius(0)
        } else {
            top + radius(0)
        };
        place(
            &mut sim,
            0,
            Vector::new(0.15, y, 0.0),
            Vector::new(0.4, 0.0, 0.0),
        );
        sim.apply(SimulationInput {
            tick: sim.tick,
            gravity: Some([0.0, -inward * sim.config.gravity, 0.0]),
            ..sim.input
        })
        .unwrap();
        for _ in 0..HZ * 2 {
            sim.step();
            let p = position(&sim, 0);
            assert!(
                velocity(&sim, 0).x <= 0.401,
                "passive join accelerated ball: {:?}",
                velocity(&sim, 0)
            );
            assert!(
                (p.y - y) * inward <= 0.001,
                "passive join made a false bump: {p:?}"
            );
        }
    }
}

#[test]
fn neighboring_band_rises_obey_the_configured_zero_release_hop() {
    for height in [MIN_HEIGHT, 0.6, 2.596923] {
        let mut sim = world(SimulationConfig {
            height,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        sim.configure_dance(DirectionOdds::default().values(), 0.0, 1, 2.0)
            .unwrap();
        input(&mut sim, [0.15; COUNT]);
        for _ in 0..HZ {
            sim.step();
        }
        let initial_height = sim.bar_positions[12] as f32 + radius(0);
        place(
            &mut sim,
            0,
            Vector::new(12.5 * PITCH - CAP_WIDTH / 2.0, initial_height, 0.0),
            Vector::ZERO,
        );
        for _ in 0..HZ {
            sim.step();
        }
        let mut lift = 0.0_f32;
        let mut impulse = 0.0;
        let mut saw_release = false;
        for tick in 0..HZ {
            let mut levels = [0.15; COUNT];
            if tick < HZ / 12 {
                levels[11] = 1.0;
                levels[13] = 1.0;
            }
            input(&mut sim, levels);
            let carried = sim.supported[0][0] && sim.driven[0][0];
            sim.step();
            assert_eq!(sim.bar_velocities[12], 0.0);
            let p = position(&sim, 0);
            lift = lift.max(p.y - initial_height);
            impulse += sim.snapshot.values[IMPULSE_OFFSET + 12];
            let distance = sim.bars[..SURFACE_END_COUNT]
                .iter()
                .filter(|(body, _)| sim.world.bodies[*body].is_enabled())
                .map(|(_, collider)| {
                    let (a, b) = chord_points(&sim.world.colliders[*collider]);
                    let edge = b - a;
                    let closest =
                        a + edge * ((p - a).dot(edge) / edge.length_squared()).clamp(0.0, 1.0);
                    (p - closest).length()
                })
                .fold(f32::INFINITY, f32::min);
            // Check separation from a driven support. A later drop onto a
            // stationary or descending bar must retain ordinary restitution.
            if carried && !sim.supported[0][0] && distance > radius(0) + 0.003 {
                saw_release = true;
                assert!(
                    velocity(&sim, 0).y <= 0.001,
                    "neighbouring bands launched the ball with zero configured hop: height={height}, tick={tick}, p={p:?}, v={:?}",
                    velocity(&sim, 0)
                );
            }
        }
        assert!(saw_release, "no driven release observed at height {height}");
        assert!(
            lift > 0.001 && impulse > 0.0,
            "neighbouring bands must physically lift the ball: lift={lift}, impulse={impulse}"
        );
    }
}

#[test]
fn stationary_ramp_endpoints_do_not_gain_horizontal_velocity_when_slopes_change() {
    let mut sim = world(SimulationConfig {
        height: 2.596923,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[]);
    input(
        &mut sim,
        std::array::from_fn(|i| if i.is_multiple_of(2) { 1.0 } else { 0.0 }),
    );
    for _ in 0..24 {
        sim.step();
        for &(handle, _) in &sim.bars {
            let body = &sim.world.bodies[handle];
            if body.is_enabled() {
                let velocity = body.velocity_at_point(body.translation());
                // Rapier derives velocity through four f32 pose products.
                // Bound their roundoff in metres, then convert to velocity
                // with the actual substep interval. The old frame produced
                // 8.9 m/s here, rather than a few coordinate ulps.
                let dt = DT / sim.snapshot.values[COST_OFFSET];
                let roundoff =
                    16.0 * f32::EPSILON * body.translation().abs().max_element().max(1.0);
                assert!(
                    velocity.x.abs() * dt <= roundoff,
                    "stationary endpoint gained horizontal velocity {velocity:?} at tick {}",
                    sim.tick
                );
            }
        }
    }
}

#[test]
fn ramp_colliders_meet_at_the_published_render_vertices_on_both_ends() {
    let mut sim = world(SimulationConfig {
        height: 2.596923,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[]);
    input(
        &mut sim,
        std::array::from_fn(|i| if i % 3 == 0 { 1.0 } else { 0.05 }),
    );
    for _ in 0..HZ {
        sim.step();
    }
    for (index, &(handle, collider)) in sim.bars.iter().enumerate() {
        let body = &sim.world.bodies[handle];
        if !body.is_enabled() {
            continue;
        }
        let band = index / 2 % COUNT;
        let end = index / SURFACE_END_COUNT;
        for vertex in 0..=1 {
            let top = sim.surface.sample(
                band,
                if index.is_multiple_of(2) {
                    0.0
                } else {
                    vertex as f64
                },
            ) as f32;
            let point = Vector::new(
                body.translation().x + vertex as f32 * ramp_width(index),
                if end == 0 {
                    top
                } else {
                    sim.ceiling_height - top
                },
                0.0,
            );
            let shape = &sim.world.colliders[collider];
            let vertices = shape.shape().as_shape::<RampPrism>().unwrap().points();
            let actual = (shape.position() * vertices[vertex]
                + shape.position() * vertices[vertex + 4])
                / 2.0;
            assert!(
                (point - actual).length() < 5e-6,
                "ramp {index}, vertex {vertex}: expected {point:?}, actual {actual:?}"
            );
            let drawn = sim.snapshot.values
                [BAR_OFFSET + (band + if index.is_multiple_of(2) { 0 } else { vertex }) % COUNT];
            assert!((top - drawn).abs() < 2e-6, "render and collision diverged");
        }
    }
}

#[test]
fn startup_waves_with_all_balls_do_not_trap_the_smallest_in_posts_or_walls() {
    use musical_lights_core::lights::{
        dance::IdlePeak,
        musical_motion::{idle_wave, listening_level},
    };
    for height in [MIN_HEIGHT, 0.6, 1.2, 2.596923] {
        for scrolling in [false, true] {
            for listening in [false, true] {
                let mut sim = world(SimulationConfig {
                    height,
                    ..SimulationConfig::default()
                });
                let mut peak = IdlePeak::default();
                let mut sequence = 0;
                let mut phase = 0.0;
                for tick in 0..HZ * 30 {
                    // The live preview publishes at 60 Hz. Its phase follows
                    // physical scrolling direction, and idle crests can reverse it.
                    if tick.is_multiple_of(2) {
                        let seconds = f64::from(tick) / f64::from(HZ);
                        if tick > 0 {
                            phase += sim.dance.direction / 60.0;
                        }
                        sim.apply(SimulationInput {
                            tick: sim.tick,
                            height,
                            scrolling,
                            levels: std::array::from_fn(|band| {
                                if listening {
                                    listening_level(0.0, band, seconds, false)
                                } else {
                                    idle_wave(band, COUNT, phase, false) as f32
                                }
                            }),
                            ..SimulationInput::default()
                        })
                        .unwrap();
                        if !listening && peak.push(seconds, false) {
                            sequence += 1;
                            sim.accent(sequence).unwrap();
                        }
                    }
                    sim.step();
                    let p = position(&sim, 0);
                    let wall =
                        p.x.min(WIDTH - p.x)
                            .min(p.y)
                            .min(sim.ceiling_height - p.y)
                            .min(sim.config.depth / 2.0 - p.z.abs());
                    // Mixed-mass contacts permit transient surface overlap,
                    // as in the full-world stress test. A centre may not escape.
                    assert!(
                        wall >= 0.0,
                        "height={height}, scrolling={scrolling}, listening={listening}, tick={tick}: wall clearance {wall}, p={p:?}"
                    );
                    for &(post, collider) in &sim.bars {
                        let post = &sim.world.bodies[post];
                        if !post.is_enabled() {
                            continue;
                        }
                        let distance = surface_clearance(&sim, collider, p);
                        assert!(
                            distance >= 0.0,
                            "height={height}, scrolling={scrolling}, listening={listening}, tick={tick}: post clearance {distance}, p={p:?}"
                        );
                    }
                }
                input(&mut sim, [0.0; COUNT]);
                for _ in 0..HZ * 120 {
                    sim.step();
                }
                let p = position(&sim, 0);
                let r = radius(0);
                let clearance =
                    p.x.min(WIDTH - p.x)
                        .min(p.y)
                        .min(sim.ceiling_height - p.y)
                        .min(sim.config.depth / 2.0 - p.z.abs());
                assert!(
                    clearance >= r - 0.001,
                    "Smallest ball remains in a wall: {p:?}"
                );
                assert!(
                    velocity(&sim, 0).length() < 0.2,
                    "Smallest ball did not settle"
                );
                for &(post, collider) in &sim.bars {
                    let post = &sim.world.bodies[post];
                    if !post.is_enabled() {
                        continue;
                    }
                    let distance = surface_clearance(&sim, collider, p);
                    assert!(
                        distance >= r - 0.001,
                        "Smallest ball remains in a post: {p:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn smallest_ball_rests_on_bar_seams_without_sinking_between_tips() {
    for ceiling in [false, true] {
        let mut sim = world(SimulationConfig::default());
        isolate(&mut sim, &[0]);
        input(&mut sim, [0.65; COUNT]);
        for _ in 0..HZ {
            sim.step();
        }
        let tip = if ceiling {
            sim.ceiling_height - sim.bar_positions[0] as f32
        } else {
            sim.bar_positions[0] as f32
        };
        let inward = if ceiling { -1.0 } else { 1.0 };
        place(
            &mut sim,
            0,
            Vector::new(PITCH * 12.0, tip + inward * (radius(0) + 0.08), 0.0),
            Vector::ZERO,
        );
        sim.apply(SimulationInput {
            tick: sim.tick,
            gravity: Some([0.0, -inward * sim.config.gravity, 0.0]),
            ..sim.input
        })
        .unwrap();
        for _ in 0..HZ * 4 {
            sim.step();
        }
        let clearance = (position(&sim, 0).y - tip) * inward - radius(0);
        assert!(
            clearance >= -0.001,
            "ceiling={ceiling}: smallest ball sank {clearance} m into the bar seam"
        );
        assert!(velocity(&sim, 0).length() < 0.01);
    }
}

#[test]
fn smallest_ball_clears_seams_after_spikes_and_motion_restarts() {
    for height in [0.6, 2.596923] {
        let mut sim = world(SimulationConfig {
            height,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        place(
            &mut sim,
            0,
            Vector::new(PITCH * 12.0, BASELINE + radius(0) + 0.01, 0.0),
            Vector::ZERO,
        );
        for tick in 0..HZ * 6 {
            let motion_on = !(tick / (HZ / 3)).is_multiple_of(3);
            let sign = if (tick / (HZ / 3)).is_multiple_of(2) {
                1.0
            } else {
                -1.0
            };
            let mut levels = [0.15; COUNT];
            levels[11 + (tick / 5 % 2) as usize] = 1.0;
            sim.apply(SimulationInput {
                tick: sim.tick,
                levels,
                height,
                acceleration: if motion_on {
                    [sign * 12.0, 0.0, sign * 8.0]
                } else {
                    [0.0; 3]
                },
                gravity: motion_on.then_some([0.0, sign * sim.config.gravity, 0.0]),
                scrolling: motion_on,
                ..SimulationInput::default()
            })
            .unwrap();
            sim.step();
            let p = position(&sim, 0);
            assert!(
                p.x >= radius(0) - 0.002 && p.x <= WIDTH - radius(0) + 0.002,
                "height={}, tick={}, p={p:?}, v={:?}",
                sim.config.height,
                sim.tick,
                velocity(&sim, 0)
            );
            assert!(p.y >= radius(0) - 0.002 && p.y <= height - radius(0) + 0.002);
        }
        // Stopping motion clears sensor forces and restores downward gravity.
        input(&mut sim, [0.65; COUNT]);
        for _ in 0..HZ {
            sim.step();
        }
        // A beach ball may still bounce. Require clearance above the complete
        // surface throughout recovery, rather than an unrelated sleep deadline.
        for _ in 0..HZ * 3 {
            sim.step();
            let clearance = position(&sim, 0).y - radius(0) - sim.bar_positions[0] as f32;
            assert!(
                clearance >= -0.001,
                "height={height}: seam clearance {clearance}"
            );
        }
    }
}

#[test]
fn smallest_ball_does_not_pass_through_moving_staggered_posts() {
    for height in [0.6, 2.596923] {
        for ceiling in [false, true] {
            let mut sim = world(SimulationConfig {
                height,
                ..SimulationConfig::default()
            });
            isolate(&mut sim, &[0]);
            let inward = if ceiling { -1.0 } else { 1.0 };
            let mut worst = 0.0_f32;
            place(
                &mut sim,
                0,
                Vector::new(
                    PITCH * 12.0,
                    if ceiling { height - 0.03 } else { 0.03 },
                    0.0,
                ),
                Vector::ZERO,
            );
            for tick in 0..HZ * 20 {
                let levels = std::array::from_fn(|i| {
                    if (i + tick as usize / 5).is_multiple_of(3) {
                        0.95
                    } else {
                        0.1
                    }
                });
                sim.apply(SimulationInput {
                    tick: sim.tick,
                    height,
                    levels,
                    gravity: Some([0.0, -inward * sim.config.gravity, 0.0]),
                    scrolling: true,
                    ..SimulationInput::default()
                })
                .unwrap();
                sim.step();
                let p = position(&sim, 0);
                for (post, collider) in &sim.bars {
                    let body = &sim.world.bodies[*post];
                    if !body.is_enabled() {
                        continue;
                    }
                    let clearance = surface_clearance(&sim, *collider, p) - radius(0);
                    worst = worst.min(clearance);
                }
            }
            // Allow brief contact-solver overlap, but keep the center outside
            // every post with at least three quarters of the radius clear.
            assert!(
                worst >= -radius(0) * 0.25,
                "height={height}, ceiling={ceiling}: {worst}"
            );
        }
    }
}
fn input(sim: &mut Simulation, levels: [f32; COUNT]) {
    sim.apply(SimulationInput {
        tick: sim.tick,
        levels,
        height: sim.config.height,
        ..SimulationInput::default()
    })
    .unwrap();
}
fn attack(sim: &mut Simulation, band: usize) {
    let mut attacks = [0.0; COUNT];
    attacks[band] = 1.0;
    sim.apply(SimulationInput {
        tick: sim.tick,
        attacks,
        ..sim.input
    })
    .unwrap();
}
#[test]
fn continuous_scroll_stops_in_place_resumes_and_recycles_only_outside() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[]);
    sim.apply(SimulationInput {
        scrolling: true,
        ..SimulationInput::default()
    })
    .unwrap();
    for _ in 0..HZ * 110 {
        let before: Vec<_> = sim
            .bars
            .iter()
            .map(|(h, _)| {
                let body = &sim.world.bodies[*h];
                (body.translation().x, body.is_enabled())
            })
            .collect();
        sim.step();
        assert!(
            sim.bars
                .iter()
                .enumerate()
                .filter(|(_, (h, _))| sim.world.bodies[*h].is_enabled())
                .map(|(index, _)| index / 2)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                <= 2 * (COUNT + 2)
        );
        for (i, (h, _)) in sim.bars.iter().enumerate() {
            let x = sim.world.bodies[*h].translation().x;
            if sim.world.bodies[*h].is_enabled() {
                assert!((-PITCH..=WIDTH + PITCH).contains(&x));
                if before[i].1 {
                    assert!((x - before[i].0).abs() < PITCH);
                }
            }
        }
    }
    let expected = SCROLL_SPEED * (110.0 - SCROLL_EASE);
    assert!((sim.scroll_phase - expected.rem_euclid(72.0)).abs() < 0.001);
    sim.apply(SimulationInput {
        tick: sim.tick,
        scrolling: false,
        ..sim.input
    })
    .unwrap();
    for _ in 0..20 {
        sim.step();
    }
    let stopped = sim.scroll_phase;
    for _ in 0..HZ {
        sim.step();
    }
    assert_eq!(sim.scroll_phase, stopped);
    sim.apply(SimulationInput {
        tick: sim.tick,
        scrolling: true,
        ..sim.input
    })
    .unwrap();
    sim.step();
    assert!(sim.scroll_phase != stopped);
    assert!((sim.scroll_phase - stopped).abs() < SCROLL_PEAK_SPEED / HZ as f64);
    sim.apply(SimulationInput {
        tick: sim.tick,
        reduced_motion: true,
        ..sim.input
    })
    .unwrap();
    for _ in 0..20 {
        sim.step();
    }
    let reduced = sim.scroll_phase;
    for _ in 0..HZ {
        sim.step();
    }
    assert_eq!(sim.scroll_phase, reduced);
}

#[test]
fn empty_space_strokes_skip_contact_work_but_nearby_strokes_keep_it() {
    let mut quiet = world(SimulationConfig::default());
    let mut distant = world(SimulationConfig::default());
    for sim in [&mut quiet, &mut distant] {
        isolate(sim, &[0]);
        place(sim, 0, Vector::new(PITCH / 2.0, 0.15, 0.0), Vector::ZERO);
    }
    let mut levels = [0.0; COUNT];
    levels[12] = 1.0;
    input(&mut distant, levels);
    let mut quiet_cost = 0.0_f32;
    for _ in 0..6 {
        quiet.step();
        distant.step();
        assert_eq!(
            quiet.snapshot.values[COST_OFFSET],
            distant.snapshot.values[COST_OFFSET]
        );
        assert_eq!(position(&quiet, 0), position(&distant, 0));
        quiet_cost = quiet_cost.max(quiet.snapshot.values[COST_OFFSET]);
    }
    levels[0] = 1.0;
    input(&mut distant, levels);
    let mut contact_cost = 0.0_f32;
    let mut impulse = 0.0;
    for _ in 0..6 {
        distant.step();
        contact_cost = contact_cost.max(distant.snapshot.values[COST_OFFSET]);
        impulse += distant.snapshot.values[IMPULSE_OFFSET];
        assert!(position(&distant, 0).y >= distant.bar_positions[0] as f32 + radius(0) - 0.002);
    }
    assert!(contact_cost > quiet_cost);
    assert!(impulse > 0.0);
}

#[test]
fn gravity_with_drag_matches_closed_form_position_and_velocity() {
    for gravity in [3.0, 9.81, 15.0] {
        let mut sim = world(SimulationConfig {
            gravity,
            height: 5.0,
            // Dense fixture isolates ideal gravity/contact laws from air drag.
            density: 20000.0,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        place(&mut sim, 0, Vector::new(0.6, 4.0, 0.0), Vector::ZERO);
        for _ in 0..HZ / 2 {
            sim.step();
        }
        let k = 3.0 * 1.225 * 0.47 / (8.0 * sim.config.density * radius(0));
        let terminal = (gravity / k).sqrt();
        let expected_v = -terminal * (gravity * 0.5 / terminal).tanh();
        let expected_y = 4.0 - (gravity * 0.5 / terminal).cosh().ln() / k;
        assert!((velocity(&sim, 0).y - expected_v).abs() < 0.003);
        assert!((position(&sim, 0).y - expected_y).abs() < 0.012);
    }
}
#[test]
fn density_sets_sphere_mass_and_rotational_inertia() {
    let sim = world(SimulationConfig::default());
    for i in 0..BALL_COUNT {
        let body = &sim.world.bodies[sim.balls[i].0];
        let expected = 4.0 / 3.0 * std::f32::consts::PI * radius(i).powi(3) * sim.config.density;
        assert!((body.mass() - expected).abs() < expected * 1e-5);
        let inertia = body.mass_properties().local_mprops.principal_inertia();
        assert!((inertia.x - 0.4 * expected * radius(i).powi(2)).abs() < 1e-6);
    }
}
#[test]
fn rebound_height_matches_restitution_squared() {
    for restitution in [0.4, SimulationConfig::default().restitution, 0.85] {
        let mut sim = world(SimulationConfig {
            restitution,
            // Dense fixture isolates ideal gravity/contact laws from air drag.
            density: 20000.0,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        // Centre over the flat bar top, 3 mm above the floor.
        place(
            &mut sim,
            0,
            Vector::new(0.625, 0.5 + radius(0), 0.0),
            Vector::ZERO,
        );
        let mut hit = false;
        let mut apex = 0.0_f32;
        for _ in 0..HZ * 2 {
            sim.step();
            if sim.snapshot.values[CONTACT_OFFSET] > 0.0 && velocity(&sim, 0).y > 0.0 {
                hit = true;
            }
            if hit {
                apex = apex.max(position(&sim, 0).y - radius(0));
            }
            if hit && velocity(&sim, 0).y < 0.0 {
                break;
            }
        }
        assert!(hit);
        assert!(
            (apex - 0.5 * restitution * restitution).abs() < 0.025,
            "e={restitution}: apex={apex}"
        );
    }
}

#[test]
fn vertical_walls_rebound_without_grabbing_tangential_motion() {
    for axis in [0, 2] {
        for sign in [-1.0, 1.0] {
            let mut sim = world(SimulationConfig {
                gravity: 0.0,
                height: 5.0,
                // Dense fixture isolates ideal gravity/contact laws from air drag.
                density: 20000.0,
                restitution: 0.55,
                ..SimulationConfig::default()
            });
            isolate(&mut sim, &[0]);
            let mut p = Vector::new(0.6, 2.0, 0.0);
            let boundary = if axis == 0 {
                if sign < 0.0 { 0.0 } else { WIDTH }
            } else {
                sign * sim.config.depth / 2.0
            };
            p[axis] = boundary - sign * (radius(0) + 0.03);
            let mut v = Vector::new(0.0, -1.0, 0.0);
            v[axis] = sign * 2.0;
            place(&mut sim, 0, p, v);
            for _ in 0..12 {
                sim.step();
            }
            let v = velocity(&sim, 0);
            // Predictive soft contact dissipates some of the ideal 55% rebound.
            // Require a useful 45–60% return, with no added collision energy.
            let rebound = -v[axis] * sign / 2.0;
            assert!(
                (0.45..=0.60).contains(&rebound),
                "axis={axis}, sign={sign}: {v:?}"
            );
            assert!((v.y + 1.0).abs() < 0.001, "wall slowed the fall: {v:?}");
        }
    }
}

#[test]
fn pressure_against_a_wall_does_not_hold_a_ball_above_the_bars() {
    for axis in [0, 2] {
        let mut sim = world(SimulationConfig {
            height: 5.0,
            // Dense fixture isolates ideal gravity/contact laws from air drag.
            density: 20000.0,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        let mut p = Vector::new(0.6, 2.0, 0.0);
        p[axis] = if axis == 0 {
            radius(0)
        } else {
            -sim.config.depth / 2.0 + radius(0)
        };
        place(&mut sim, 0, p, Vector::ZERO);
        let mut acceleration = [0.0; 3];
        acceleration[axis] = -100.0;
        sim.apply(SimulationInput {
            acceleration,
            height: 5.0,
            ..SimulationInput::default()
        })
        .unwrap();
        for _ in 0..HZ / 4 {
            sim.step();
        }
        assert!((velocity(&sim, 0).y + sim.config.gravity * 0.25).abs() < 0.005);
        assert!(
            (position(&sim, 0).y - (2.0 - 0.5 * sim.config.gravity * 0.25_f32.powi(2))).abs()
                < 0.012
        );
    }
}

#[test]
fn moderate_wall_impacts_do_not_skip_ccd_or_pass_the_inner_surface() {
    for speed in [1.0, 2.3, 5.0, 10.0, 20.0] {
        let mut sim = world(SimulationConfig {
            gravity: 0.0,
            height: 5.0,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        place(
            &mut sim,
            0,
            Vector::new(0.1, 1.0, 0.0),
            Vector::new(-speed, 0.0, 0.0),
        );
        let mut bounced = false;
        for _ in 0..HZ {
            sim.step();
            assert!(
                position(&sim, 0).x >= 0.0,
                "speed {speed}: {:?}",
                position(&sim, 0)
            );
            if velocity(&sim, 0).x > 0.0 {
                bounced = true;
                break;
            }
        }
        assert!(bounced, "speed {speed}");
    }
}

#[test]
fn attacks_arrive_within_50_ms_and_releases_brake_before_gravity() {
    for height in [0.4, 0.6, 2.0] {
        let mut sim = world(SimulationConfig {
            height,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[]);
        for level in [1.0, 0.0, 1.0, 0.0] {
            input(&mut sim, [level; COUNT]);
            let (max_speed, acceleration) = sim.config.motion_limits(false);
            for _ in 0..if level > 0.0 { 6 } else { 160 } {
                let previous = sim.bar_velocities[0];
                sim.step();
                assert!(sim.bar_velocities[0].abs() <= max_speed + 1e-5);
                assert!(
                    (sim.bar_velocities[0] - previous).abs() <= acceleration * f64::from(DT) + 1e-5
                );
                assert!(sim.snapshot.values[COST_OFFSET] <= MAX_SUBSTEPS as f32);
            }
            let target = BASELINE + level * (sim.config.bar_max() - BASELINE);
            assert!((sim.snapshot.values[BAR_OFFSET] - target).abs() < height * 0.01);
            assert!(sim.bar_velocities[0].abs() < 1e-6);
        }
        input(&mut sim, [1.0; COUNT]);
        // Interrupt the rising stroke before it reaches its target.
        sim.step();
        sim.step();
        sim.step();
        let velocity = sim.bar_velocities[0];
        assert!(velocity > 0.0);
        input(&mut sim, [0.0; COUNT]);
        assert_eq!(sim.bar_velocities[0], velocity);
        sim.step();
        assert!(sim.bar_velocities[0] < velocity);
        let mut ticks = 1;
        while sim.bar_velocities[0] >= 0.0 && ticks < 12 {
            sim.step();
            ticks += 1;
        }
        assert!(ticks <= 5, "reversal took {ticks} ticks");
        eprintln!(
            "height {height}: reversal begins after {} ms",
            ticks as f32 * DT * 1000.0
        );
        for _ in 0..160 {
            sim.step();
        }
        assert!((sim.snapshot.values[BAR_OFFSET] - BASELINE).abs() < height * 0.01);
    }
}
#[test]
fn all_rises_start_continuously_and_settle_within_fifty_ms() {
    for amplitude in [0.001, 0.01, 0.1, 0.5, 1.0] {
        let mut sim = world(SimulationConfig::default());
        isolate(&mut sim, &[]);
        for level in [amplitude, 0.0] {
            input(&mut sim, [level; COUNT]);
            for tick in 0..if level > 0.0 { 18 } else { 160 } {
                sim.step();
                if tick == 0 {
                    assert!(sim.bar_velocities[0].abs() > 0.0);
                }
                if tick == 0 && level > 0.0 {
                    assert!(sim.motions[0].state.position < f64::from(level) * 0.1);
                }
                if tick == 4 && level > 0.0 {
                    assert_eq!(sim.motions[0].state.position, f64::from(level));
                    assert_eq!(sim.motions[0].state.velocity, 0.0);
                }
            }
            assert_eq!(sim.motions[0].state.position, f64::from(level));
            assert_eq!(sim.motions[0].state.velocity, 0.0);
            assert_eq!(sim.motions[0].state.acceleration, 0.0);
        }
    }
}

#[test]
fn tiny_bar_corrections_do_not_launch_resting_balls_high() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(PITCH * 0.5, BASELINE + radius(0), 0.0),
        Vector::ZERO,
    );
    for _ in 0..HZ {
        sim.step();
    }
    let mut levels = [0.0; COUNT];
    levels[0] = 0.01;
    input(&mut sim, levels);
    let mut clearance = 0.0_f32;
    for _ in 0..HZ {
        sim.step();
        clearance =
            clearance.max(position(&sim, 0).y - radius(0) - sim.snapshot.values[BAR_OFFSET]);
    }
    eprintln!("1% bar rise: maximum ball clearance {clearance} m");
    assert!(
        clearance < 0.015,
        "tiny correction launched a ball {clearance} m"
    );
    assert!(velocity(&sim, 0).length() < 0.01);
}

#[test]
fn small_repeated_fluctuations_do_not_build_up_bar_speed() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[]);
    input(&mut sim, [0.4; COUNT]);
    for _ in 0..12 {
        sim.step();
    }
    let mut peak = 0.0_f64;
    for tick in 0..HZ * 2 {
        let level = 0.4 + 0.005 * (tick as f32 * DT * 8.0 * std::f32::consts::TAU).sin();
        input(&mut sim, [level; COUNT]);
        sim.step();
        peak = peak.max(sim.bar_velocities[0].abs());
    }
    eprintln!("8 Hz, +/-0.5% target: peak bar speed {peak} m/s");
    assert!(peak < 0.3, "small fluctuations kick the bars at {peak} m/s");
    input(&mut sim, [0.4; COUNT]);
    for _ in 0..HZ {
        sim.step();
    }
    assert!(sim.bar_velocities[0].abs() < 1e-6);
}

#[test]
fn reduced_motion_uses_a_slower_stroke() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[]);
    sim.apply(SimulationInput {
        levels: [1.0; COUNT],
        reduced_motion: true,
        ..SimulationInput::default()
    })
    .unwrap();
    for _ in 0..12 {
        sim.step();
    }
    assert!(sim.snapshot.values[BAR_OFFSET] < 0.2);
    for _ in 0..28 {
        sim.step();
    }
    assert!((sim.snapshot.values[BAR_OFFSET] - sim.config.bar_max()).abs() < 0.001);
}
#[test]
fn unequal_masses_transfer_linear_and_angular_momentum() {
    let mut sim = world(SimulationConfig {
        gravity: 0.0,
        height: 5.0,
        restitution: 1.0,
        friction: 0.4,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0, 1]);
    place(
        &mut sim,
        0,
        Vector::new(0.4, 0.8, 0.0),
        Vector::new(1.0, 0.12, 0.0),
    );
    place(&mut sim, 1, Vector::new(0.55, 0.815, 0.0), Vector::ZERO);
    let momentum = |s: &Simulation| -> (Vector, Vector) {
        let mut linear = Vector::ZERO;
        let mut angular = Vector::ZERO;
        for i in [0, 1] {
            let body = &s.world.bodies[s.balls[i].0];
            let p = body.linvel() * body.mass();
            linear += p;
            angular += body.translation().cross(p)
                + body.angvel() * (0.4 * body.mass() * radius(i).powi(2));
        }
        (linear, angular)
    };
    let before = momentum(&sim);
    for _ in 0..HZ * 22 / 120 {
        sim.step();
    }
    let after = momentum(&sim);
    assert!((before.0 - after.0).length() < 1e-4);
    assert!((before.1 - after.1).length() < 2e-5);
    assert!(velocity(&sim, 0).x < 0.0);
    assert!(velocity(&sim, 1).x > 0.03);
    for i in [0, 1] {
        assert!(sim.world.bodies[sim.balls[i].0].angvel().length() > 0.01);
    }
}
#[test]
fn sustained_stroke_moves_each_of_six_stacked_balls() {
    let mut sim = world(SimulationConfig {
        height: 1.2,
        ..SimulationConfig::default()
    });
    let indices = [0, 3, 5, 1, 2, 7];
    isolate(&mut sim, &indices);
    let mut y = BASELINE;
    for i in indices {
        y += radius(i);
        place(&mut sim, i, Vector::new(0.625, y, 0.0), Vector::ZERO);
        y += radius(i);
    }
    let before = indices.map(|i| position(&sim, i).y);
    let mut impulses = [0.0; 6];
    let mut maximum = before;
    let mut levels = [0.0; COUNT];
    levels[12] = 1.0;
    input(&mut sim, levels);
    for tick in 0..HZ * 4 / 5 {
        sim.step();
        if tick == 11 {
            assert!((sim.snapshot.values[BAR_OFFSET + 12] - sim.config.bar_max()).abs() < 0.0114);
        }
        for (j, i) in indices.into_iter().enumerate() {
            maximum[j] = maximum[j].max(position(&sim, i).y);
            impulses[j] += sim.snapshot.values[CONTACT_OFFSET + i];
        }
    }
    for j in 0..6 {
        assert!(
            maximum[j] > before[j] + 0.15,
            "ball {}: {} -> {}, impulse {}",
            indices[j],
            before[j],
            maximum[j],
            impulses[j]
        );
        assert!(
            impulses[j] > 0.001,
            "ball {} has no contact impulse",
            indices[j]
        );
    }
    assert!((sim.snapshot.values[BAR_OFFSET + 12] - sim.config.bar_max()).abs() < 0.005);
}
#[test]
fn short_stroke_transfers_only_contact_impulses() {
    let mut sim = world(SimulationConfig {
        height: 1.2,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0, 1]);
    place(
        &mut sim,
        0,
        Vector::new(0.625, BASELINE + radius(0), 0.0),
        Vector::ZERO,
    );
    place(&mut sim, 1, Vector::new(0.625, 0.8, 0.0), Vector::ZERO);
    let mut levels = [0.0; COUNT];
    levels[12] = 1.0;
    input(&mut sim, levels);
    sim.step();
    sim.step();
    assert!(velocity(&sim, 0).y > 0.5);
    assert!(velocity(&sim, 1).y < 0.0);
    assert_eq!(sim.snapshot.values[CONTACT_OFFSET + 1], 0.0);
    assert!(sim.snapshot.values[BAR_OFFSET + 12] < position(&sim, 1).y - radius(1));
}
#[test]
fn side_front_and_back_walls_rebound_without_tunneling() {
    for (start, speed, axis, sign) in [
        (
            Vector::new(0.1, 1.0, 0.0),
            Vector::new(-20.0, 0.0, 0.0),
            0,
            1.0,
        ),
        (
            Vector::new(1.1, 1.0, 0.0),
            Vector::new(20.0, 0.0, 0.0),
            0,
            -1.0,
        ),
        (
            Vector::new(0.6, 1.0, 0.0),
            Vector::new(0.0, 0.0, -20.0),
            2,
            1.0,
        ),
        (
            Vector::new(0.6, 1.0, 0.0),
            Vector::new(0.0, 0.0, 20.0),
            2,
            -1.0,
        ),
    ] {
        let mut sim = world(SimulationConfig {
            gravity: 0.0,
            height: 5.0,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        place(&mut sim, 0, start, speed);
        for _ in 0..3 {
            sim.step();
            if velocity(&sim, 0)[axis] * sign > 0.0 {
                break;
            }
        }
        assert!(
            velocity(&sim, 0)[axis] * sign > 0.0,
            "start {start:?}, velocity {:?}, position {:?}",
            velocity(&sim, 0),
            position(&sim, 0)
        );
        let p = position(&sim, 0);
        assert!(
            p.x >= radius(0) - 0.002 && p.x <= WIDTH - radius(0) + 0.002,
            "start {start:?}: {p:?}, v={:?}",
            velocity(&sim, 0)
        );
        assert!(p.z.abs() <= sim.config.depth / 2.0 - radius(0) + 0.002);
    }
}
#[test]
fn ceiling_bounces_and_shrinks_without_teleporting_balls() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(0.625, 0.5, 0.0),
        Vector::new(0.0, 3.0, 0.0),
    );
    let p = position(&sim, 0);
    let v = velocity(&sim, 0);
    sim.apply(SimulationInput {
        tick: 0,
        height: MIN_HEIGHT,
        ..SimulationInput::default()
    })
    .unwrap();
    assert_eq!(position(&sim, 0), p);
    assert_eq!(velocity(&sim, 0), v);
    let mut bounced = false;
    for _ in 0..HZ {
        sim.step();
        assert!(position(&sim, 0).y + radius(0) <= sim.ceiling_height + 0.002);
        bounced |= velocity(&sim, 0).y < 0.0;
    }
    assert!(bounced);
    assert_eq!(sim.ceiling_height, MIN_HEIGHT);
}
#[test]
fn recorded_inputs_replay_identically_at_all_render_rates() {
    let records: Vec<_> = (0..5 * HZ as u64)
        .step_by(5)
        .map(|tick| SimulationInput {
            tick,
            levels: std::array::from_fn(|i| ((tick as usize / 5 + i) % 11) as f32 / 10.0),
            attacks: std::array::from_fn(|i| {
                if (tick / 5 + i as u64).is_multiple_of(7) {
                    0.5
                } else {
                    0.0
                }
            }),
            acceleration: [((tick / 5) % 3) as f32 - 1.0, 0.0, 0.0],
            scrolling: (tick / 50) % 3 != 0,
            ..SimulationInput::default()
        })
        .collect();
    let replay = |fps| {
        let mut sim = world(SimulationConfig::default());
        for _ in 0..5 * fps {
            for _ in 0..HZ / fps {
                if let Some(input) = records.iter().find(|input| input.tick == sim.tick) {
                    sim.apply(*input).unwrap();
                }
                sim.step();
            }
        }
        (sim.snapshot, sim.pigments)
    };
    assert_eq!(replay(30), replay(60));
    assert_eq!(replay(60), replay(120));
}
#[test]
fn all_balls_remain_contained_and_settle_after_dense_full_height_peaks() {
    let mut sim = world(SimulationConfig::default());
    let mut worst_penetration = 0.0_f32;
    let mut worst_fraction = 0.0_f32;
    let mut impulses = [0.0; BALL_COUNT];
    for tick in 0..HZ as usize * 20 {
        if tick % (HZ as usize / 6) == 0 {
            input(
                &mut sim,
                std::array::from_fn(|i| {
                    if (tick / (HZ as usize / 6) + i).is_multiple_of(3) {
                        0.0
                    } else {
                        1.0
                    }
                }),
            );
        }
        sim.step();
        for (i, impulse) in impulses.iter_mut().enumerate() {
            let p = position(&sim, i);
            assert!(p.is_finite() && velocity(&sim, i).is_finite());
            // A contact solver permits transient penetration. A centre crossing a
            // boundary, or overlap that persists after settling, is not acceptable.
            let clearance =
                p.x.min(WIDTH - p.x)
                    .min(p.y)
                    .min(sim.ceiling_height - p.y)
                    .min(sim.config.depth / 2.0 - p.z.abs());
            assert!(clearance >= 0.0, "tick {tick}, ball {i} escaped: {p:?}");
            worst_penetration = worst_penetration.max(radius(i) - clearance);
            worst_fraction = worst_fraction.max((radius(i) - clearance) / radius(i));
            *impulse += sim.snapshot.values[CONTACT_OFFSET + i];
        }
    }
    input(&mut sim, [0.0; COUNT]);
    for _ in 0..HZ * 120 {
        sim.step();
    }
    // Resting stacks are valid. Require a contact path down to the floor or
    // lowered bar tops instead of requiring every sphere to touch the floor.
    let mut supported: [bool; BALL_COUNT] =
        std::array::from_fn(|i| position(&sim, i).y <= radius(i) + BASELINE + 0.001);
    for _ in 0..BALL_COUNT {
        let previous = supported;
        for (i, supported) in supported.iter_mut().enumerate() {
            *supported |= (0..BALL_COUNT).any(|j| {
                previous[j]
                    && position(&sim, j).y < position(&sim, i).y
                    && sim
                        .world
                        .narrow_phase
                        .contact_pair(sim.balls[i].1, sim.balls[j].1)
                        .is_some_and(|pair| pair.has_any_active_contact())
            });
        }
        if previous == supported {
            break;
        }
    }
    for (i, impulse) in impulses.iter().enumerate() {
        assert!(*impulse > 0.0, "ball {i} never contacted the enclosure");
        let p = position(&sim, i);
        let clearance =
            p.x.min(WIDTH - p.x)
                .min(p.y)
                .min(sim.ceiling_height - p.y)
                .min(sim.config.depth / 2.0 - p.z.abs());
        assert!(
            clearance >= radius(i) - 0.001,
            "ball {i} remains in a wall: {p:?}"
        );
        assert!(
            supported[i],
            "ball {i} remains above the lowered bars without a contact path to support: {p:?}"
        );
        assert!(velocity(&sim, i).length() < 0.2, "ball {i} did not settle");
        for j in 0..i {
            assert!(
                (p - position(&sim, j)).length() >= radius(i) + radius(j) - 0.001,
                "balls {i} and {j} remain overlapped"
            );
        }
    }
    eprintln!(
        "20-second stress: maximum transient penetration {worst_penetration} m, {worst_fraction} of radius; all {BALL_COUNT} balls settled within 1 mm"
    );
}
#[test]
fn invalid_inputs_and_configuration_leave_state_unchanged() {
    assert!(SimulationConfig::from_values(&[f32::NAN; 8]).is_err());
    let mut sim = world(SimulationConfig::default());
    let before = sim.snapshot.clone();
    let input = SimulationInput {
        tick: 1,
        ..SimulationInput::default()
    };
    assert!(sim.apply(input).is_err());
    assert_eq!(before, sim.snapshot);
    for value in [f32::NAN, -0.1, 1.1] {
        let mut input = SimulationInput::default();
        input.attacks[6] = value;
        assert!(sim.apply(input).is_err());
        assert_eq!(before, sim.snapshot);
    }
}

#[test]
fn sloped_band_join_deflects_a_ball_and_reports_the_bar_impulse() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    let top = 0.1;
    let mut levels = [0.0; COUNT];
    levels[12] = (top - BASELINE) / (sim.config.bar_max() - BASELINE);
    input(&mut sim, levels);
    for _ in 0..HZ {
        sim.step();
    }
    place(
        &mut sim,
        0,
        Vector::new(
            0.625 + PITCH / 2.0 + radius(0) / 2.0,
            top + radius(0) + 0.08,
            0.0,
        ),
        Vector::new(0.0, -1.0, 0.0),
    );
    let mut impulse = 0.0;
    let mut horizontal_speed = 0.0_f32;
    for _ in 0..60 {
        sim.step();
        impulse += sim.snapshot.values[IMPULSE_OFFSET + 12];
        horizontal_speed = horizontal_speed.max(velocity(&sim, 0).x);
    }
    assert!(impulse / sim.world.bodies[sim.balls[0].0].mass() > 0.1);
    assert!(horizontal_speed > 0.2);
}
#[test]
fn acceleration_is_a_force_over_time_and_resting_contact_does_not_recolor() {
    let mut sim = world(SimulationConfig {
        gravity: 0.0,
        height: 5.0,
        // Dense fixture isolates ideal gravity/contact laws from air drag.
        density: 20000.0,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0]);
    place(&mut sim, 0, Vector::new(0.625, 2.0, 0.0), Vector::ZERO);
    sim.apply(SimulationInput {
        acceleration: [0.0, 2.0, 0.0],
        height: 5.0,
        ..SimulationInput::default()
    })
    .unwrap();
    for _ in 0..HZ / 2 {
        sim.step();
    }
    assert!((velocity(&sim, 0).y - 1.0).abs() < 0.001);
    let mut sim = world(SimulationConfig {
        restitution: 0.0,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0]);
    place(&mut sim, 0, Vector::new(0.625, 0.3, 0.0), Vector::ZERO);
    let initial = target_color(&sim, 0);
    for _ in 0..HZ * 2 {
        sim.step();
    }
    let resting = target_color(&sim, 0);
    assert_ne!(
        initial, resting,
        "The initial impact must pick up the contacted bar's color"
    );
    assert_first_ball_fills_toward_source(&sim, 12);
    for _ in 0..HZ * 2 {
        sim.step();
    }
    assert_eq!(resting, target_color(&sim, 0));
}

#[test]
fn ccd_resolves_two_fast_spheres_before_they_cross() {
    let mut sim = world(SimulationConfig {
        gravity: 0.0,
        height: 5.0,
        restitution: 1.0,
        friction: 0.0,
        // Dense fixture isolates ideal gravity/contact laws from air drag.
        density: 20000.0,
        ..SimulationConfig::default()
    });
    // Make the second fixture sphere identical to the first; the production
    // palette no longer needs duplicate sizes just to exercise equal-mass CCD.
    let (body, collider) = sim.balls[1];
    sim.world.colliders[collider].set_shape(SharedShape::ball(radius(0)));
    sim.world.bodies[body].recompute_mass_properties_from_colliders(&sim.world.colliders);
    isolate(&mut sim, &[0, 1]);
    place(
        &mut sim,
        0,
        Vector::new(0.45, 1.0, 0.0),
        Vector::new(20.0, 0.0, 0.0),
    );
    place(
        &mut sim,
        1,
        Vector::new(0.65, 1.0, 0.0),
        Vector::new(-20.0, 0.0, 0.0),
    );
    for _ in 0..3 {
        sim.step();
        assert!(
            position(&sim, 0).x <= position(&sim, 1).x,
            "spheres passed through each other"
        );
        if velocity(&sim, 0).x < 0.0 {
            break;
        }
    }
    assert!(velocity(&sim, 0).x < -19.0);
    assert!(velocity(&sim, 1).x > 19.0);
}

#[test]
fn all_six_enclosure_planes_contain_fast_launches() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(0.6, 0.3, 0.0),
        Vector::new(80.0, 20.0, 40.0),
    );
    for _ in 0..HZ {
        sim.step();
        let p = position(&sim, 0);
        assert!(
            p.x >= 0.0
                && p.x <= WIDTH
                && p.y >= 0.0
                && p.y <= sim.ceiling_height
                && p.z.abs() <= sim.config.depth / 2.0,
            "escaped: {p:?}"
        );
    }
}
#[test]
fn substep_overload_is_visible_without_discarding_a_tick() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(0.6, 0.3, 0.0),
        Vector::new(0.0, 1000.0, 0.0),
    );
    sim.step();
    assert_eq!(sim.tick, 1);
    assert_eq!(sim.snapshot.values[COST_OFFSET], 128.0);
    assert!(sim.snapshot.values[COST_OFFSET + 1] > 0.0);
    assert!(position(&sim, 0).y <= sim.ceiling_height);
}

#[test]
fn beach_balls_rebound_with_quadratic_drag_and_settle_on_quiet_bars() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(0.625, BASELINE + radius(0) + 0.5, 0.0),
        Vector::ZERO,
    );
    let mut contacted = false;
    let mut rebound = 0.0_f32;
    for _ in 0..HZ * 3 {
        sim.step();
        contacted |= sim.snapshot.values[CONTACT_OFFSET] > 0.0;
        if contacted {
            rebound = rebound.max(position(&sim, 0).y - radius(0) - BASELINE);
        }
    }
    assert!(contacted);
    println!("default 0.5 m drop: rebound {rebound} m");
    // Independent closed-form vertical quadratic-drag solution: v² after
    // falling h, followed by height from the restitution-scaled impact speed.
    let k = 3.0 * 1.225 * 0.47 / (8.0 * sim.config.density * radius(0));
    let impact_v2 = sim.config.gravity / k * (1.0 - (-2.0 * k * 0.5).exp());
    let expected = (1.0 + k * sim.config.restitution.powi(2) * impact_v2 / sim.config.gravity).ln()
        / (2.0 * k);
    assert!(
        (rebound - expected).abs() < 0.012,
        "rebound {rebound}, drag solution {expected}"
    );
    assert!(velocity(&sim, 0).length() < 0.01);
    assert!((position(&sim, 0).y - radius(0) - BASELINE).abs() < 0.001);
}

#[test]
fn initial_placement_fits_the_minimum_closed_enclosure_without_overlap() {
    let sim = world(SimulationConfig {
        height: MIN_HEIGHT,
        ..SimulationConfig::default()
    });
    for i in 0..BALL_COUNT {
        let p = position(&sim, i);
        assert!(p.y - radius(i) >= BASELINE && p.y + radius(i) < MIN_HEIGHT);
        assert!(p.x >= radius(i) && p.x + radius(i) <= WIDTH);
        for j in 0..i {
            assert!((p - position(&sim, j)).length() >= radius(i) + radius(j));
        }
    }
}

#[test]
fn simultaneous_full_strokes_do_not_push_stacks_through_the_ceiling() {
    for height in [MIN_HEIGHT, 0.415, 0.6, 1.2, 2.596923] {
        for warmup in [0, HZ / 8, HZ / 4, HZ] {
            let mut sim = world(SimulationConfig {
                height,
                ..SimulationConfig::default()
            });
            for _ in 0..warmup {
                sim.step();
            }
            input(&mut sim, [1.0; COUNT]);
            let mut worst = 0.0_f32;
            for _ in 0..HZ {
                sim.step();
                for i in 0..BALL_COUNT {
                    worst = worst.max(position(&sim, i).y + radius(i) - sim.ceiling_height);
                }
            }
            assert!(
                worst <= 0.005,
                "height={height}, warmup={warmup}: ceiling penetration {worst}"
            );
        }
    }
}

#[test]
fn strong_bar_launches_have_small_release_hops_in_both_motion_modes() {
    for height in [MIN_HEIGHT, 0.6, 1.2] {
        for reduced in [false, true] {
            let mut sim = world(SimulationConfig {
                height,
                ..SimulationConfig::default()
            });
            isolate(&mut sim, &[0]);
            place(
                &mut sim,
                0,
                Vector::new(PITCH / 2.0, BASELINE + radius(0), 0.0),
                Vector::ZERO,
            );
            for _ in 0..HZ {
                sim.step();
            }
            let mut values = [0.0; COUNT];
            values[0] = 1.0;
            sim.apply(SimulationInput {
                tick: sim.tick,
                levels: values,
                height,
                reduced_motion: reduced,
                ..SimulationInput::default()
            })
            .unwrap();
            let mut worst = 0.0_f32;
            for _ in 0..HZ * 2 {
                sim.step();
                worst =
                    worst.max(position(&sim, 0).y - radius(0) - sim.snapshot.values[BAR_OFFSET]);
                assert!(position(&sim, 0).y + radius(0) <= sim.ceiling_height + 0.002);
            }
            assert!(
                worst <= sim.config.hop_height(reduced) + 0.005,
                "H={height}, reduced={reduced}, hop={worst}"
            );
        }
    }
}

#[test]
fn fullscreen_resize_is_bounded_and_repeated_packets_do_not_restart_it() {
    for levels in [
        [1.0; COUNT],
        std::array::from_fn(|i| if i % 4 == 0 { 0.6 } else { 0.0 }),
    ] {
        let mut sim = world(SimulationConfig {
            height: 0.927803,
            ..SimulationConfig::default()
        });
        for _ in 0..2 * HZ {
            sim.apply(SimulationInput {
                tick: sim.tick,
                levels,
                height: 0.927803,
                ..SimulationInput::default()
            })
            .unwrap();
            sim.step();
        }
        for height in [2.596923, 0.5545024, MIN_HEIGHT] {
            let before = sim.config.height;
            let p = position(&sim, 0);
            let v = velocity(&sim, 0);
            sim.apply(SimulationInput {
                tick: sim.tick,
                levels,
                height,
                ..SimulationInput::default()
            })
            .unwrap();
            assert_eq!(position(&sim, 0), p);
            assert_eq!(velocity(&sim, 0), v);
            assert_eq!(sim.config.height, before);
            for tick in 1..=RESIZE_TICKS {
                sim.apply(SimulationInput {
                    tick: sim.tick,
                    levels,
                    height,
                    ..SimulationInput::default()
                })
                .unwrap();
                sim.step();
                assert!(
                    sim.config.height >= before.min(height)
                        && sim.config.height <= before.max(height)
                );
                assert_eq!(
                    sim.snapshot.values[COST_OFFSET + 1],
                    0.0,
                    "resize capped at {tick}"
                );
                if tick == RESIZE_TICKS / 2 {
                    assert!((sim.config.height - (before + height) / 2.0).abs() < 1e-6);
                }
                for i in 0..BALL_COUNT {
                    assert!(position(&sim, i).y + radius(i) <= sim.ceiling_height + 0.002);
                }
            }
            assert_eq!(sim.config.height, height);
            assert_eq!(sim.snapshot.values[1], height);
        }
    }
}

#[test]
fn resize_reversal_starts_at_applied_height_and_replays_at_all_frame_rates() {
    let replay = |fps| {
        let mut sim = world(SimulationConfig::default());
        for _ in 0..fps {
            for _ in 0..HZ / fps {
                let height = if sim.tick < 18 { 2.596923 } else { MIN_HEIGHT };
                let previous = sim.config.height;
                sim.apply(SimulationInput {
                    tick: sim.tick,
                    height,
                    ..SimulationInput::default()
                })
                .unwrap();
                assert_eq!(sim.config.height, previous);
                sim.step();
                if sim.tick > 18 {
                    assert!(sim.config.height <= previous);
                }
            }
        }
        assert_eq!(sim.config.height, MIN_HEIGHT);
        sim.snapshot
    };
    assert_eq!(replay(30), replay(60));
    assert_eq!(replay(60), replay(120));
}

#[test]
fn scrolling_contacts_keep_source_impulses_and_color_at_the_wrap() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    // Source 23 is now across the left seam; the collider copy at x=0.025
    // must retain source 23's impulse column and palette entry.
    sim.scroll_phase = 1.0;
    attack(&mut sim, 23);
    sim.step();
    place(
        &mut sim,
        0,
        Vector::new(PITCH / 2.0, 0.15, 0.0),
        Vector::ZERO,
    );
    let initial = target_color(&sim, 0);
    let mut impulse = 0.0;
    for _ in 0..HZ {
        sim.step();
        impulse += sim.snapshot.values[IMPULSE_OFFSET + 23];
        assert!(position(&sim, 0).x >= radius(0) - 0.002);
        assert!(position(&sim, 0).x <= WIDTH - radius(0) + 0.002);
    }
    assert!(impulse > 0.0);
    assert!(target_color(&sim, 0)[0] > initial[0]);
    assert!(target_color(&sim, 0)[0] < sim.palette[23][0]);
    // Enable actual lateral motion and phone force while maintaining enclosure bounds.
    sim.apply(SimulationInput {
        tick: sim.tick,
        scrolling: true,
        acceleration: [-2.0, 0.0, 1.0],
        ..sim.input
    })
    .unwrap();
    for _ in 0..HZ * 3 {
        sim.step();
        let p = position(&sim, 0);
        assert!(
            p.x >= radius(0) - 0.002 && p.x <= WIDTH - radius(0) + 0.002,
            "height={}, tick={}, p={p:?}, v={:?}",
            sim.config.height,
            sim.tick,
            velocity(&sim, 0)
        );
        assert!(p.y >= radius(0) - 0.002 && p.y + radius(0) <= sim.ceiling_height + 0.002);
    }
}

#[test]
fn rapid_reversals_with_scrolling_keep_balls_inside_the_enclosure() {
    let mut sim = world(SimulationConfig {
        height: MIN_HEIGHT,
        ..SimulationConfig::default()
    });
    for tick in 0..HZ {
        if tick % 3 == 0 {
            sim.apply(SimulationInput {
                tick: sim.tick,
                levels: [if tick % 6 == 0 { 1.0 } else { 0.0 }; COUNT],
                scrolling: true,
                height: MIN_HEIGHT,
                ..sim.input
            })
            .unwrap();
        }
        sim.step();
        for i in 0..BALL_COUNT {
            let p = position(&sim, i);
            assert!(
                p.y + radius(i) <= sim.ceiling_height + 0.005,
                "ball {i} escaped roof at tick {tick}"
            );
            assert!(p.x >= radius(i) - 0.005 && p.x <= WIDTH - radius(i) + 0.005);
        }
    }
}

#[test]
fn unchanged_direction_stays_contained_when_balls_reach_the_wall() {
    let mut sim = world(SimulationConfig::default());
    input(&mut sim, [0.3; COUNT]);
    for _ in 0..HZ * 2 {
        sim.step();
    }
    sim.apply(SimulationInput {
        tick: sim.tick,
        scrolling: true,
        ..sim.input
    })
    .unwrap();
    let mut min_speed = 0.0_f64;
    let mut max_speed = 0.0_f64;
    let mut worst_center = 0.0_f32;
    for _ in 0..HZ * 64 {
        sim.step();
        min_speed = min_speed.min(sim.scroll_speed);
        max_speed = max_speed.max(sim.scroll_speed);
        let center = (0..BALL_COUNT).map(|i| position(&sim, i).x).sum::<f32>() / BALL_COUNT as f32;
        worst_center = worst_center.max(center);
        for i in 0..BALL_COUNT {
            let x = position(&sim, i).x;
            assert!(x >= radius(i) - 0.008 && x <= WIDTH - radius(i) + 0.008);
        }
    }
    assert!(worst_center > WIDTH * 0.75);
    assert!(min_speed >= 0.0 && max_speed > 0.5);
}

#[test]
fn measured_gravity_can_point_up_or_through_the_screen_and_is_not_reduced() {
    for gravity in [[0.0, 9.81, 0.0], [0.0, 0.0, -9.81], [0.0, 0.0, 9.81]] {
        for reduced_motion in [false, true] {
            let mut sim = world(SimulationConfig::default());
            isolate(&mut sim, &[0]);
            place(&mut sim, 0, Vector::new(0.6, 0.3, 0.0), Vector::ZERO);
            sim.apply(SimulationInput {
                gravity: Some(gravity),
                reduced_motion,
                ..SimulationInput::default()
            })
            .unwrap();
            for _ in 0..6 {
                sim.step();
            }
            let g = Vector::from_array(gravity);
            assert_eq!(sim.world.gravity, g);
            let k = 3.0 * 1.225 * 0.47 / (8.0 * sim.config.density * radius(0));
            let terminal = (g.length() / k).sqrt();
            let expected = g / g.length() * terminal * (g.length() * 0.05 / terminal).tanh();
            assert!((velocity(&sim, 0) - expected).length() < 0.006);
        }
    }
}

#[test]
fn turning_over_wakes_settled_balls_and_stopping_restores_default_gravity() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    for _ in 0..HZ * 4 {
        sim.step();
    }
    sim.apply(SimulationInput {
        tick: sim.tick,
        gravity: Some([0.0, 9.81, 0.0]),
        ..SimulationInput::default()
    })
    .unwrap();
    for _ in 0..HZ / 5 {
        sim.step();
    }
    let k = 3.0 * 1.225 * 0.47 / (8.0 * sim.config.density * radius(0));
    let terminal = (9.81 / k).sqrt();
    let expected = terminal * (9.81 * 0.2 / terminal).tanh();
    assert!((velocity(&sim, 0).y - expected).abs() < 0.025);
    assert!(position(&sim, 0).y > 0.15);
    sim.apply(SimulationInput {
        tick: sim.tick,
        ..SimulationInput::default()
    })
    .unwrap();
    let before = velocity(&sim, 0).y;
    sim.step();
    let expected = terminal * ((before / terminal).atan() - 9.81 * DT / terminal).tan();
    assert!((velocity(&sim, 0).y - expected).abs() < 0.004);
    assert_eq!(sim.world.gravity, Vector::new(0.0, -9.81, 0.0));
}

#[test]
fn air_drag_dissipates_fast_free_motion_without_changing_gravity() {
    let mut sim = world(SimulationConfig {
        gravity: 0.0,
        height: 3.0,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(0.6, 1.0, 0.0),
        Vector::new(0.0, 8.0, 0.0),
    );
    sim.step();
    assert!(velocity(&sim, 0).y > 0.0 && velocity(&sim, 0).y < 8.0);
    assert_eq!(sim.world.gravity, Vector::ZERO);
}

#[test]
fn quiet_bar_contacts_pick_up_the_contacted_color() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    attack(&mut sim, 7); // An unrelated attack must not choose the painted source.
    place(
        &mut sim,
        0,
        Vector::new(PITCH * 12.5, radius(0) + 0.025, 0.0),
        Vector::ZERO,
    );
    let colors = sim.color_targets;
    let pigments = sim.pigments;
    let mut impulse = 0.0;
    for _ in 0..HZ * 2 {
        sim.step();
        impulse += sim.snapshot.values[IMPULSE_OFFSET + 12];
    }
    assert!(impulse > 0.0, "The quiet bar must make physical contact");
    assert_ne!(sim.color_targets, colors);
    assert_ne!(sim.pigments, pigments);
    assert_first_ball_fills_toward_source(&sim, 12);
}

#[test]
fn idle_and_listening_contacts_pick_up_colors_without_audio_attacks() {
    use musical_lights_core::lights::musical_motion::{idle_wave, listening_level};
    for listening in [false, true] {
        let mut sim = world(SimulationConfig::default());
        isolate(&mut sim, &[0]);
        place(
            &mut sim,
            0,
            Vector::new(PITCH * 12.5, 0.3, 0.0),
            Vector::ZERO,
        );
        let colors = sim.color_targets;
        let pigments = sim.pigments;
        let mut impulse = 0.0;
        let mut minimum = f64::INFINITY;
        let mut maximum = 0.0_f64;
        for _ in 0..HZ * 6 {
            let seconds = sim.tick as f64 / f64::from(HZ);
            input(
                &mut sim,
                std::array::from_fn(|band| {
                    if listening {
                        listening_level(0.0, band, seconds, false)
                    } else {
                        idle_wave(band, COUNT, seconds, false) as f32
                    }
                }),
            );
            sim.step();
            impulse += sim.snapshot.values[IMPULSE_OFFSET..CONTACT_OFFSET]
                .iter()
                .sum::<f32>();
            minimum = minimum.min(sim.bar_positions[6]);
            maximum = maximum.max(sim.bar_positions[6]);
        }
        assert!(impulse > 0.0, "The wave must make physical contact");
        assert!(maximum - minimum > 0.01, "The bars must move");
        assert_ne!(sim.color_targets, colors);
        assert_ne!(sim.pigments, pigments);
        assert!(sim.input.attacks.iter().all(|value| *value == 0.0));
    }
}

#[test]
fn both_bar_ends_pick_up_the_contacted_color_at_every_audio_attack_strength() {
    for roof in [false, true] {
        for strength in [0.0, 0.001, 1.0] {
            let mut sim = world(SimulationConfig {
                gravity: 0.0,
                ..SimulationConfig::default()
            });
            isolate(&mut sim, &[0]);
            let mut levels = [0.0; COUNT];
            levels[12] = 0.6;
            input(&mut sim, levels);
            for _ in 0..HZ {
                sim.step();
            }
            attack(&mut sim, 12);
            let mut attacks = [0.0; COUNT];
            attacks[12] = strength; // Zero also tests a completed attack before contact.
            attacks[7] = 1.0; // A different source must not qualify this contact.
            sim.apply(SimulationInput {
                tick: sim.tick,
                attacks,
                ..sim.input
            })
            .unwrap();
            let top = sim.bar_positions[12] as f32;
            let sign = if roof { -1.0 } else { 1.0 };
            let y = if roof { sim.ceiling_height - top } else { top };
            place(
                &mut sim,
                0,
                Vector::new(0.625, y + sign * (radius(0) + 0.02), 0.0),
                Vector::new(0.0, -sign, 0.0),
            );
            let colors = sim.color_targets;
            let pigments = sim.pigments;
            let mut impulse = 0.0;
            for _ in 0..HZ / 3 {
                sim.step();
                impulse += sim.snapshot.values[IMPULSE_OFFSET + 12];
            }
            assert!(impulse > 0.0);
            assert_ne!(sim.color_targets, colors);
            assert_ne!(sim.pigments, pigments);
            assert_first_ball_fills_toward_source(&sim, 12);
        }
    }
}

#[test]
fn contact_fill_continues_while_resting_without_repainting_the_target() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);

    place(
        &mut sim,
        0,
        Vector::new(PITCH * 12.5, radius(0) + 0.025, 0.0),
        Vector::ZERO,
    );
    for _ in 0..180 {
        sim.step();
    }
    assert_first_ball_fills_toward_source(&sim, 12);
    let target = sim.color_targets;
    let error = |surface: &[f32]| {
        surface
            .iter()
            .zip(&target[..9])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max)
    };
    let previous_error = error(&sim.pigments[..9]);
    for _ in 0..120 {
        sim.step();
    }
    assert_eq!(
        sim.color_targets, target,
        "Resting pressure must not add new color"
    );
    assert!(error(&sim.pigments[..9]) < previous_error);
    assert!(error(&sim.pigments[..9]) < 0.001);
}

#[test]
fn tempo_updates_preserve_scroll_position_and_scale_signed_travel() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[]);
    sim.apply(SimulationInput {
        scrolling: true,
        ..SimulationInput::default()
    })
    .unwrap();
    for _ in 0..(HZ / 4) as usize {
        sim.step();
    }
    let phase = sim.scroll_phase;
    sim.set_tempo(180.0);
    assert_eq!(sim.scroll_phase, phase);
    sim.step();
    let faster = sim.scroll_phase - phase;
    let mut slow = world(SimulationConfig::default());
    isolate(&mut slow, &[]);
    slow.apply(SimulationInput {
        scrolling: true,
        ..SimulationInput::default()
    })
    .unwrap();
    for _ in 0..(HZ / 4) as usize {
        slow.step();
    }
    let phase = slow.scroll_phase;
    slow.step();
    let slower = slow.scroll_phase - phase;
    assert!(faster > slower && faster < slower * 1.5);
    for _ in 0..HZ {
        sim.step();
        slow.step();
    }
    let (fast_phase, slow_phase) = (sim.scroll_phase, slow.scroll_phase);
    sim.step();
    slow.step();
    assert!(
        ((sim.scroll_phase - fast_phase) / (slow.scroll_phase - slow_phase) - 1.5).abs() < 0.01
    );
}

#[test]
fn paired_bars_move_inward_together_and_leave_ball_clearance() {
    let mut sim = world(SimulationConfig::default());
    sim.apply(SimulationInput {
        levels: [0.7; COUNT],
        height: 0.6,
        scrolling: true,
        ..SimulationInput::default()
    })
    .unwrap();
    let gravity = sim.world.gravity;
    for _ in 0..HZ * 2 {
        sim.step();
        assert_eq!(sim.world.gravity, gravity);
        for band in 0..COUNT {
            let floor = sim.world.bodies[sim.bars[band * 2].0].translation().y;
            let roof = sim.world.bodies[sim.bars[band * 2 + SURFACE_END_COUNT].0]
                .translation()
                .y;
            assert!((floor + roof - sim.ceiling_height).abs() < 1e-5);
            assert!(roof - floor >= radius(4) * 2.0);
        }
        for (i, &(handle, _)) in sim.balls.iter().enumerate() {
            let p = sim.world.bodies[handle].translation();
            assert!(
                p.y >= radius(i) - 0.008 && p.y <= sim.ceiling_height - radius(i) + 0.008,
                "ball {i}: {p:?}"
            );
        }
    }
    let expected = f64::from(BASELINE) + 0.7 * f64::from(sim.bar_max() - BASELINE);
    assert!((sim.bar_positions[0] - expected).abs() < 1e-5);
}
#[test]
fn reduced_motion_and_scrolling_off_consume_accents_without_flips() {
    for reduced in [true, false] {
        let mut sim = world(SimulationConfig::default());
        sim.configure_dance(DirectionOdds::default().values(), 0.3, 42, 2.0)
            .unwrap();
        sim.apply(SimulationInput {
            reduced_motion: reduced,
            scrolling: reduced,
            height: 0.6,
            ..SimulationInput::default()
        })
        .unwrap();
        sim.accent(1000).unwrap();
        assert_eq!(sim.dance.direction, 1.0);
        assert_eq!(sim.accent_sequence, 1000);
    }
}

#[test]
fn roof_bar_deflects_inward_and_reports_its_source_pigment() {
    let mut sim = world(SimulationConfig {
        gravity: 0.0,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0]);
    let mut levels = [0.0; COUNT];
    levels[12] = 0.6;
    input(&mut sim, levels);
    for _ in 0..HZ {
        sim.step();
    }
    let tip = sim.ceiling_height - sim.bar_positions[12] as f32;
    attack(&mut sim, 12);
    place(
        &mut sim,
        0,
        Vector::new(0.625, tip - radius(0) - 0.02, 0.0),
        Vector::new(0.0, 1.0, 0.0),
    );
    let mut impulse = 0.0;
    let mut inward = false;
    for _ in 0..HZ / 3 {
        sim.step();
        impulse += sim.snapshot.values[IMPULSE_OFFSET + 12];
        inward |= velocity(&sim, 0).y < -0.1;
    }
    assert!(
        impulse > 0.0 && inward,
        "impulse={impulse}, inward={inward}, p={:?}, v={:?}, tip={tip}",
        position(&sim, 0),
        velocity(&sim, 0)
    );
    assert_first_ball_fills_toward_source(&sim, 12);
}

#[test]
fn default_full_attacks_stay_within_the_work_cap_in_tall_phone_rooms() {
    for height in [0.927803, 2.596923, 2.75] {
        let mut sim = world(SimulationConfig {
            height,
            ..SimulationConfig::default()
        });
        input(&mut sim, [0.0; COUNT]);
        for _ in 0..HZ {
            sim.step();
        }
        input(&mut sim, [1.0; COUNT]);
        for _ in 0..16 {
            sim.step();
            assert_eq!(sim.snapshot.values[COST_OFFSET + 1], 0.0);
            assert!(sim.snapshot.values[COST_OFFSET] <= MAX_SUBSTEPS as f32);
        }
    }
}

#[test]
fn initial_ball_colors_match_spawn_x_and_stay_uniform_without_contacts() {
    let mut sim = world(SimulationConfig {
        gravity: 0.0,
        ..SimulationConfig::default()
    });
    // Expected source columns for the existing size-sorted spawn rows.
    let sources = [6, 18, 10, 2, 6, 22, 2, 14];
    let initial = sim.pigments;
    for (i, band) in sources.into_iter().enumerate() {
        let x = position(&sim, i).x;
        assert!(x >= band as f32 * PITCH && x < (band + 1) as f32 * PITCH);
        assert_eq!(target_color(&sim, i), sim.palette[band]);
        for color in sim.pigments[i * 9..i * 9 + 9].as_chunks::<3>().0 {
            assert_eq!(color, &sim.palette[band]);
        }
    }
    // Moving through X in free space must not invent new contact pigments.
    sim.world.bodies[sim.balls[0].0].set_linvel(Vector::new(0.1, 0.0, 0.0), true);
    for _ in 0..HZ {
        sim.step();
    }
    assert_eq!(sim.pigments, initial);
}

#[test]
fn live_depth_resizes_walls_and_posts_without_resetting_state() {
    let mut sim = world(SimulationConfig::default());
    let tick = sim.tick;
    let pigments = sim.pigments;
    let ball = sim.balls[0].0;
    sim.world.bodies[ball].set_translation(Vector::new(0.6, 0.4, 0.15), true);
    sim.world.bodies[ball].set_linvel(Vector::new(0.2, 0.3, 0.4), true);
    sim.apply(SimulationInput {
        tick,
        depth: 2.0,
        ..sim.input
    })
    .unwrap();
    sim.resize_depth();
    assert_eq!(sim.tick, tick);
    assert_eq!(sim.pigments, pigments);
    assert_eq!(sim.world.bodies[ball].linvel(), Vector::new(0.2, 0.3, 0.4));
    assert_eq!(sim.world.bodies[sim.depth_walls[0]].translation().z, -1.0);
    assert_eq!(sim.world.bodies[sim.depth_walls[1]].translation().z, 1.0);
    for &(_, handle) in &sim.bars {
        assert_eq!(
            sim.world.colliders[handle]
                .shape()
                .compute_local_aabb()
                .maxs
                .z,
            1.0
        );
    }
    sim.apply(SimulationInput {
        tick,
        depth: 0.2,
        ..sim.input
    })
    .unwrap();
    sim.resize_depth();
    assert!(sim.world.bodies[ball].translation().z <= 0.1 - radius(0));
    assert_eq!(sim.world.bodies[ball].linvel(), Vector::new(0.2, 0.3, 0.0));
    assert_eq!(sim.pigments, pigments);
    sim.step();
    assert_eq!(sim.tick, tick + 1);
    assert_eq!(sim.snapshot.values[GEOMETRY_OFFSET + 4], 0.2);
}

#[test]
fn invalid_live_depth_keeps_the_current_room_and_input() {
    let mut sim = world(SimulationConfig::default());
    for depth in [f32::NAN, 0.0, 0.199, 2.001, f32::INFINITY] {
        assert!(
            sim.apply(SimulationInput {
                tick: sim.tick,
                depth,
                ..sim.input
            })
            .is_err()
        );
        assert_eq!(sim.input.depth, 0.48);
        assert_eq!(sim.config.depth, 0.48);
    }
}

#[test]
fn contact_color_spreads_without_jumps_even_when_impacts_retarget_the_fill() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(PITCH * 12.5, radius(0) + 0.025, 0.0),
        Vector::ZERO,
    );
    let initial = target_color(&sim, 0);
    let mut contacted = false;
    for tick in 0..HZ * 2 {
        let before = sim.pigments;
        sim.step();
        for (old, new) in before.into_iter().zip(sim.pigments) {
            assert!((old - new).abs() < 0.038, "tick {tick}: surface jumped");
        }
        if !contacted && target_color(&sim, 0) != initial {
            contacted = true;
            let delta = |region: usize| sim.pigments[region * 3] - before[region * 3];
            assert!((0..3).any(|region| delta(region) > 0.0));
            assert!((0..3).all(|region| delta(region) >= 0.0));
            assert!((sim.snapshot.values[18] - initial[0]).abs() < 0.01);
        }
    }
    assert!(contacted);
    assert_first_ball_fills_toward_source(&sim, 12);
    // A new target during filling must also remain continuous.
    sim.color_targets[..9].copy_from_slice(&[0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0]);
    let before = sim.pigments;
    sim.step();
    for (old, new) in before.into_iter().zip(sim.pigments) {
        assert!((old - new).abs() < 0.038);
    }
}

#[test]
fn both_halves_of_each_flat_top_transfer_the_same_source_color() {
    for end in 0..2 {
        for offset in [-CAP_WIDTH / 4.0, CAP_WIDTH / 4.0] {
            let mut sim = world(SimulationConfig::default());
            isolate(&mut sim, &[0]);
            input(&mut sim, [0.3; COUNT]);
            for _ in 0..HZ {
                sim.step();
            }
            let inward = if end == 0 { 1.0 } else { -1.0 };
            let top = sim.bar_positions[12] as f32;
            let y = if end == 0 {
                top
            } else {
                sim.ceiling_height - top
            };
            place(
                &mut sim,
                0,
                Vector::new(12.5 * PITCH + offset, y + inward * (radius(0) + 0.04), 0.0),
                Vector::new(0.0, -inward * 0.2, 0.0),
            );
            sim.apply(SimulationInput {
                tick: sim.tick,
                gravity: Some([0.0, -inward * sim.config.gravity, 0.0]),
                ..sim.input
            })
            .unwrap();
            let mut contacted = false;
            for _ in 0..HZ {
                sim.step();
                let impulses = &sim.snapshot.values[IMPULSE_OFFSET..IMPULSE_OFFSET + COUNT];
                if impulses.iter().sum::<f32>() > 0.0 {
                    assert!(
                        impulses[12] > 0.0,
                        "flat source lost its impulse: end={end}, offset={offset}, {impulses:?}"
                    );
                    for (band, &impulse) in impulses.iter().enumerate() {
                        if band != 12 {
                            assert_eq!(
                                impulse, 0.0,
                                "flat top recolored from band {band}: end={end}, offset={offset}"
                            );
                        }
                    }
                    assert_first_ball_fills_toward_source(&sim, 12);
                    contacted = true;
                    break;
                }
            }
            assert!(contacted, "no flat-top contact: end={end}, offset={offset}");
        }
    }
}

#[test]
fn active_audio_requires_attacking_contacts_and_a_new_attack_can_light_resting_balls() {
    let mut sim = world(SimulationConfig {
        restitution: 0.0,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(12.5 * PITCH, BASELINE + radius(0), 0.0),
        Vector::ZERO,
    );
    sim.apply(SimulationInput {
        attack_required: true,
        ..sim.input
    })
    .unwrap();
    let initial = sim.color_targets;
    let mut impulse = 0.0;
    for _ in 0..HZ {
        sim.step();
        impulse += sim.snapshot.values[IMPULSE_OFFSET + 12];
    }
    assert!(
        impulse > 0.0,
        "the quiet source must physically support the ball"
    );
    assert_eq!(
        sim.color_targets, initial,
        "a non-attacking bar repainted the ball"
    );
    let before = sim.pigments;
    let mut attacks = [0.0; COUNT];
    attacks[12] = 1.0;
    sim.apply(SimulationInput {
        tick: sim.tick,
        attacks,
        ..sim.input
    })
    .unwrap();
    sim.step();
    assert_ne!(
        sim.color_targets, initial,
        "a new attack did not light the resting contact"
    );
    for (old, new) in before.into_iter().zip(sim.pigments) {
        assert!((old - new).abs() < 0.038);
    }
    let held = sim.color_targets;
    for _ in 0..HZ {
        sim.step();
    }
    assert_eq!(
        sim.color_targets, held,
        "held pressure repeatedly painted one attack"
    );
    attacks[12] = 0.25;
    sim.apply(SimulationInput {
        tick: sim.tick,
        attacks,
        ..sim.input
    })
    .unwrap();
    sim.step();
    assert_eq!(sim.color_targets, held);
    attacks[12] = 0.75;
    sim.apply(SimulationInput {
        tick: sim.tick,
        attacks,
        ..sim.input
    })
    .unwrap();
    sim.step();
    assert_ne!(
        sim.color_targets, held,
        "a later attack on the same contact was lost"
    );
}

#[test]
fn physical_contact_injects_color_at_the_rolling_balls_material_point() {
    let run = |angle| {
        let mut sim = world(SimulationConfig {
            restitution: 0.0,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        place(
            &mut sim,
            0,
            Vector::new(12.5 * PITCH, BASELINE + radius(0), 0.0),
            Vector::ZERO,
        );
        sim.world.bodies[sim.balls[0].0].set_rotation(Rotation::from_rotation_x(angle), true);
        for _ in 0..HZ {
            sim.step();
        }
        assert_first_ball_fills_toward_source(&sim, 12);
        sim.color_targets[..9].to_vec()
    };
    let upright = run(0.0);
    let turned = run(core::f32::consts::PI);
    assert_ne!(
        upright, turned,
        "rotation must change which swirl regions receive the contact light"
    );
    assert!(upright[0] > upright[6]);
    assert!(turned[6] > turned[0]);
}
