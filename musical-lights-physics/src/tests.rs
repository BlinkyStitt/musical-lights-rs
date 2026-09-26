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
fn gravity_matches_ballistic_position_and_velocity() {
    for gravity in [3.0, 9.81, 15.0] {
        let mut sim = world(SimulationConfig {
            gravity,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[0]);
        place(&mut sim, 0, Vector::new(0.6, 4.0, 0.0), Vector::ZERO);
        for _ in 0..HZ / 2 {
            sim.step();
        }
        assert!((velocity(&sim, 0).y + gravity * 0.5).abs() < 0.003);
        assert!((position(&sim, 0).y - (4.0 - 0.5 * gravity * 0.25)).abs() < 0.012);
    }
}
#[test]
fn density_sets_sphere_mass_and_rotational_inertia() {
    let sim = world(SimulationConfig::default());
    for i in 0..COUNT {
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
fn moderate_wall_impacts_do_not_skip_ccd_or_pass_the_inner_surface() {
    for speed in [1.0, 2.3, 5.0, 10.0, 20.0] {
        let mut sim = world(SimulationConfig {
            gravity: 0.0,
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
fn full_strokes_arrive_within_50_ms_and_preserve_velocity_on_reversal() {
    for height in [0.1, 0.6, 2.0] {
        let mut sim = world(SimulationConfig {
            height,
            ..SimulationConfig::default()
        });
        isolate(&mut sim, &[]);
        for level in [1.0, 0.0, 1.0, 0.0] {
            input(&mut sim, [level; COUNT]);
            let (max_speed, acceleration) = sim.config.motion_limits(false);
            for _ in 0..6 {
                let previous = sim.bar_velocities[0];
                sim.step();
                assert!(sim.bar_velocities[0].abs() <= max_speed + 1e-5);
                assert!(
                    (sim.bar_velocities[0] - previous).abs() <= acceleration * f64::from(DT) + 1e-5
                );
                assert!(sim.snapshot.values[COST_OFFSET] <= MAX_SUBSTEPS as f32);
            }
            let target = BASELINE + level * (height * (1.0 - HEADROOM) - BASELINE);
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
        for _ in 0..12 {
            sim.step();
        }
        assert!((sim.snapshot.values[BAR_OFFSET] - BASELINE).abs() < height * 0.01);
    }
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
    assert!((sim.snapshot.values[BAR_OFFSET] - 0.57).abs() < 0.001);
}
#[test]
fn unequal_masses_transfer_linear_and_angular_momentum() {
    let mut sim = world(SimulationConfig {
        gravity: 0.0,
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
    let indices = [0, 3, 5, 12, 15, 17];
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
            assert!((sim.snapshot.values[BAR_OFFSET + 12] - 1.14).abs() < 0.0114);
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
    assert!((sim.snapshot.values[BAR_OFFSET + 12] - 1.14).abs() < 0.005);
}
#[test]
fn short_stroke_transfers_only_contact_impulses() {
    let mut sim = world(SimulationConfig::default());
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
fn open_top_and_resize_preserve_ball_state() {
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
        height: 0.3,
        ..SimulationInput::default()
    })
    .unwrap();
    assert_eq!(position(&sim, 0), p);
    assert_eq!(velocity(&sim, 0), v);
    let mut above = false;
    let mut returned = false;
    for _ in 0..HZ {
        sim.step();
        above |= position(&sim, 0).y > 0.9;
        returned |= above && position(&sim, 0).y < sim.config.height;
    }
    assert!(above);
    assert!(returned);
}
#[test]
fn recorded_inputs_replay_identically_at_all_render_rates() {
    let records: Vec<_> = (0..5 * HZ as u64)
        .step_by(5)
        .map(|tick| SimulationInput {
            tick,
            levels: std::array::from_fn(|i| ((tick as usize / 5 + i) % 11) as f32 / 10.0),
            acceleration: [((tick / 5) % 3) as f32 - 1.0, 0.0, 0.0],
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
    let mut impulses = [0.0; COUNT];
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
    let mut supported: [bool; COUNT] =
        std::array::from_fn(|i| position(&sim, i).y <= radius(i) + BASELINE + 0.001);
    for _ in 0..COUNT {
        let previous = supported;
        for (i, supported) in supported.iter_mut().enumerate() {
            *supported |= (0..COUNT).any(|j| {
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
        "20-second stress: maximum transient penetration {worst_penetration} m, {worst_fraction} of radius; all 24 balls settled within 1 mm"
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
    levels[12] = (top - BASELINE) / (sim.config.height * (1.0 - HEADROOM) - BASELINE);
    input(&mut sim, levels);
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
    assert!(impulse > 0.001);
    assert!(horizontal_speed > 0.2);
}
#[test]
fn acceleration_is_a_force_over_time_and_resting_contact_does_not_recolor() {
    let mut sim = world(SimulationConfig {
        gravity: 0.0,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0]);
    place(&mut sim, 0, Vector::new(0.625, 2.0, 0.0), Vector::ZERO);
    sim.apply(SimulationInput {
        acceleration: [0.0, 2.0, 0.0],
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
        restitution: 1.0,
        friction: 0.0,
        ..SimulationConfig::default()
    });
    isolate(&mut sim, &[0, 17]);
    place(
        &mut sim,
        0,
        Vector::new(0.45, 1.0, 0.0),
        Vector::new(20.0, 0.0, 0.0),
    );
    place(
        &mut sim,
        17,
        Vector::new(0.65, 1.0, 0.0),
        Vector::new(-20.0, 0.0, 0.0),
    );
    for _ in 0..3 {
        sim.step();
        assert!(
            position(&sim, 0).x <= position(&sim, 17).x,
            "spheres passed through each other"
        );
        if velocity(&sim, 0).x < 0.0 {
            break;
        }
    }
    assert!(velocity(&sim, 0).x < -19.0);
    assert!(velocity(&sim, 17).x > 19.0);
}

#[test]
fn infinite_sides_contain_launches_above_the_previous_wall_height() {
    let mut sim = world(SimulationConfig::default());
    isolate(&mut sim, &[0]);
    place(
        &mut sim,
        0,
        Vector::new(0.6, 150.0, 0.0),
        Vector::new(80.0, 20.0, 40.0),
    );
    for _ in 0..HZ {
        sim.step();
        let p = position(&sim, 0);
        assert!(
            p.x >= 0.0 && p.x <= WIDTH && p.z.abs() <= sim.config.depth / 2.0,
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
        Vector::new(0.6, 150.0, 0.0),
        Vector::new(0.0, 1000.0, 0.0),
    );
    sim.step();
    assert_eq!(sim.tick, 1);
    assert_eq!(sim.snapshot.values[COST_OFFSET], 128.0);
    assert!(sim.snapshot.values[COST_OFFSET + 1] > 0.0);
    assert!((position(&sim, 0).y - (150.0 + 1000.0 * DT)).abs() < 0.01);
}

#[test]
fn default_balls_have_a_small_rebound_and_settle_on_quiet_bars() {
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
    assert!(rebound < 0.025, "default rebound too large: {rebound} m");
    assert!(velocity(&sim, 0).length() < 0.01);
    assert!((position(&sim, 0).y - radius(0) - BASELINE).abs() < 0.001);
}
