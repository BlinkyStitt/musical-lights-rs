use super::*;

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
    SIZE_RATIOS[i] * (PITCH - GAP) / 2.0
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
            .map(|(h, _)| sim.world.bodies[*h].translation().x)
            .collect();
        sim.step();
        assert!(
            sim.bars
                .iter()
                .filter(|(h, _)| sim.world.bodies[*h].is_enabled())
                .count()
                <= COUNT + 2
        );
        for (i, (h, _)) in sim.bars.iter().enumerate() {
            let x = sim.world.bodies[*h].translation().x;
            assert_eq!(
                sim.world.bodies[*h].is_enabled(),
                (-PITCH..=WIDTH + PITCH).contains(&x)
            );
            if (x - before[i]).abs() > PITCH {
                assert!(x < -PITCH || x > WIDTH + PITCH);
                assert!(before[i] < -PITCH || before[i] > WIDTH + PITCH);
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
    levels[23] = 1.0;
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
        sim.step();
        sim.step();
        sim.step();
        let velocity = sim.bar_velocities[0];
        assert!(velocity > 0.0);
        input(&mut sim, [0.0; COUNT]);
        assert_eq!(sim.bar_velocities[0], velocity);
        sim.step();
        assert!(sim.bar_velocities[0] > 0.0 && sim.bar_velocities[0] < velocity);
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
fn tiny_corrections_move_gently_and_settle_exactly_within_150_ms() {
    for amplitude in [0.001, 0.01] {
        let mut sim = world(SimulationConfig::default());
        isolate(&mut sim, &[]);
        for level in [amplitude, 0.0] {
            input(&mut sim, [level; COUNT]);
            for tick in 0..18 {
                sim.step();
                if tick == 0 {
                    assert!(sim.bar_velocities[0].abs() > 0.0);
                }
                if tick == 5 && level > 0.0 {
                    assert_ne!(sim.motions[0].state.position, f64::from(level));
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
        sim.snapshot
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
}

#[test]
fn rounded_top_deflects_a_ball_and_reports_the_bar_impulse() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    let top = 0.2;
    let bar = &mut sim.world.bodies[sim.bars[12].0];
    bar.set_translation(Vector::new(0.625, top - POST_HEIGHT / 2.0, 0.0), true);
    sim.bar_positions[12] = f64::from(top);
    let mut levels = [0.0; COUNT];
    levels[12] = (top - BASELINE) / (sim.config.bar_max() - BASELINE);
    input(&mut sim, levels);
    sim.motions[12].state.position = f64::from(levels[12]);
    sim.motions[12].target = f64::from(levels[12]);
    place(
        &mut sim,
        0,
        Vector::new(0.648, top + radius(0) + 0.08, 0.0),
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
    let initial = sim.colors[0];
    for _ in 0..HZ * 2 {
        sim.step();
    }
    let resting = sim.colors[0];
    assert_ne!(initial, resting);
    for _ in 0..HZ * 2 {
        sim.step();
    }
    assert_eq!(resting, sim.colors[0]);
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
    sim.step();
    place(
        &mut sim,
        0,
        Vector::new(PITCH / 2.0, 0.15, 0.0),
        Vector::ZERO,
    );
    let initial = sim.colors[0];
    let mut impulse = 0.0;
    for _ in 0..HZ {
        sim.step();
        impulse += sim.snapshot.values[IMPULSE_OFFSET + 23];
        assert!(position(&sim, 0).x >= radius(0) - 0.002);
        assert!(position(&sim, 0).x <= WIDTH - radius(0) + 0.002);
    }
    assert!(impulse > 0.0);
    assert!(sim.colors[0][0] > initial[0]);
    assert!(sim.colors[0][0] < sim.palette[23][0]);
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
        assert!(p.x >= radius(0) - 0.002 && p.x <= WIDTH - radius(0) + 0.002);
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
fn contact_pigments_remember_source_and_resting_load_does_not_change_history() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(PITCH * 6.5, radius(0) + 0.025, 0.0),
        Vector::ZERO,
    );
    for _ in 0..180 {
        sim.step();
    }
    assert_eq!(&sim.pigments[..3], &sim.palette[6]);
    let history = sim.pigments;
    for _ in 0..120 {
        sim.step();
    }
    assert_eq!(sim.pigments, history);
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
fn ceiling_transition_retracts_before_switching_and_preserves_gravity() {
    let mut sim = world(SimulationConfig::default());
    sim.apply(SimulationInput {
        levels: [0.7; COUNT],
        height: 0.6,
        scrolling: true,
        ..SimulationInput::default()
    })
    .unwrap();
    for _ in 0..HZ {
        sim.step();
    }
    let gravity = sim.world.gravity;
    sim.dance.ceiling = true;
    let mut switched = false;
    for _ in 0..HZ * 2 {
        let before = sim.ceiling_bars;
        sim.step();
        if before != sim.ceiling_bars {
            switched = true;
            assert!(
                sim.bar_positions
                    .iter()
                    .all(|height| *height < f64::from(BASELINE) + 0.001)
            );
        }
        assert_eq!(sim.world.gravity, gravity);
        for (i, &(handle, _)) in sim.balls.iter().enumerate() {
            let p = sim.world.bodies[handle].translation();
            assert!(
                p.y >= radius(i) - 0.008 && p.y <= sim.ceiling_height - radius(i) + 0.008,
                "ball {i}: {p:?}"
            );
        }
    }
    assert!(switched && sim.ceiling_bars);
    assert!(sim.bar_positions.iter().any(|height| *height > 0.1));
}
#[test]
fn reduced_motion_and_scrolling_off_consume_accents_without_flips() {
    for reduced in [true, false] {
        let mut sim = world(SimulationConfig::default());
        sim.configure_dance(1.0, 0.3, 42).unwrap();
        sim.apply(SimulationInput {
            reduced_motion: reduced,
            scrolling: reduced,
            height: 0.6,
            ..SimulationInput::default()
        })
        .unwrap();
        sim.accent(1000).unwrap();
        assert_eq!(sim.dance.direction, 1.0);
        assert!(!sim.dance.ceiling);
        assert_eq!(sim.accent_sequence, 1000);
    }
}
