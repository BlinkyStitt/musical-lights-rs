use super::*;

fn world() -> BalloonWorld {
    let mut world = BalloonWorld::new(Gradient::new_rainbow(90.0, 58.0));
    world.reduced = true;
    world
}

fn geometry() -> Geometry {
    Geometry {
        bars: std::array::from_fn(|i| Bar {
            left: i as f64 / DISPLAY_BANDS as f64,
            right: (i as f64 + 0.75) / DISPLAY_BANDS as f64,
        }),
        bar_height: 0.65,
        aspect: 1.2,
    }
}

fn frame(band: usize, level: f32) -> DisplayFrame<DISPLAY_BANDS> {
    let mut frame = DisplayFrame::default();
    frame.levels[band] = level;
    frame
}

#[test]
fn sphere_contract_gravity_accelerates_down_in_every_phone_orientation() {
    for angle in [0.0, 90.0, 180.0, 270.0] {
        for (beta, gamma) in [(0.0, 0.0), (-90.0, 90.0), (90.0, -90.0)] {
            let mut world = world();
            world.reduced = false;
            world.tilt(beta, gamma, angle);
            let before = world.balloons[0].position;
            for _ in 0..18 {
                world.step(1.0 / 60.0, DisplayFrame::default(), geometry());
            }
            assert!(
                world.balloons[0].position.y < before.y - 0.08,
                "page-down gravity at beta={beta}, gamma={gamma}, angle={angle}"
            );
            assert!(world.balloons[0].velocity.y < -0.5);
        }
    }
}

#[test]
fn sphere_contract_color_follows_starting_x_and_body_is_round() {
    let world = world();
    for balloon in &world.balloons {
        let band = (balloon.position.x * DISPLAY_BANDS as f64) as usize;
        assert_eq!(balloon.color, world.palette[band]);
        let radius = geometry().radii(balloon);
        assert_eq!(radius.y, radius.x * geometry().aspect);
    }
}

#[test]
fn sphere_contract_floor_impact_bounces_then_gravity_returns_it_downward() {
    let mut world = world();
    world.reduced = false;
    let radius = geometry().radii(&world.balloons[0]);
    world.balloons[0].position.y = radius.y + 0.001;
    world.balloons[0].velocity.y = -1.0;
    let color = world.balloons[0].color;
    world.step(1.0 / 60.0, DisplayFrame::default(), geometry());
    assert!(world.balloons[0].velocity.y > 0.5);
    // The remaining substeps continue the rebound after the floor impact.
    assert!((radius.y..radius.y + 0.012).contains(&world.balloons[0].position.y));
    assert_eq!(world.balloons[0].color, color);
    for _ in 0..22 {
        world.step(1.0 / 60.0, DisplayFrame::default(), geometry());
    }
    assert!(world.balloons[0].velocity.y < 0.0);
}

#[test]
fn free_fall_agrees_across_refresh_rates_and_reduced_motion_still_falls() {
    let mut reference = world();
    reference.reduced = false;
    for _ in 0..12 {
        reference.step(1.0 / 30.0, DisplayFrame::default(), geometry());
    }
    for hz in [60, 120, 240] {
        let mut world = world();
        world.reduced = false;
        for _ in 0..hz * 2 / 5 {
            world.step(1.0 / hz as f64, DisplayFrame::default(), geometry());
        }
        assert!((world.balloons[0].position.y - reference.balloons[0].position.y).abs() < 1e-10);
        assert!((world.balloons[0].velocity.y - reference.balloons[0].velocity.y).abs() < 1e-10);
    }
    let mut reduced = world();
    let initial = reduced.balloons[0].position.y;
    for _ in 0..12 {
        reduced.step(1.0 / 30.0, DisplayFrame::default(), geometry());
    }
    assert!(reduced.balloons[0].position.y < initial - 0.01);
    assert!(
        initial - reference.balloons[0].position.y
            > 5.0 * (initial - reduced.balloons[0].position.y)
    );
}

fn over_bar(world: &mut BalloonWorld, band: usize, bottom: f64) {
    let geometry = geometry();
    let balloon = &mut world.balloons[0];
    balloon.width_in_bars = 0.55;
    balloon.position = Vector {
        x: (geometry.bars[band].left + geometry.bars[band].right) * 0.5,
        y: bottom + geometry.radii(balloon).y,
    };
    balloon.velocity = Vector::default();
}

#[test]
fn starting_sizes_positions_and_palette_are_deterministic() {
    let first = world();
    assert_eq!(first.balloons, world().balloons);
    assert_eq!(
        first.balloons.map(|b| b.width_in_bars),
        [0.55, 1.4, 2.2, 0.8, 3.1, 1.0, 4.0, 1.8, 0.65, 2.6, 1.2, 3.5]
    );
    let first = world();
    assert_eq!(first.balloons[0].position, Vector { x: 0.08, y: 0.52 });
    for balloon in &first.balloons {
        assert_eq!(
            balloon.color,
            first.palette[(balloon.position.x * DISPLAY_BANDS as f64) as usize]
        );
        let radius = geometry().radii(balloon);
        assert!((radius.x..=1.0 - radius.x).contains(&balloon.position.x));
        assert!((radius.y..=1.0 - radius.y).contains(&balloon.position.y));
    }
}

#[test]
fn mouse_repels_in_both_axes_and_reduced_motion_limits_displacement() {
    let mut reduced = world();
    reduced.balloons[0].position = Vector { x: 0.4, y: 0.5 };
    reduced.pointer = Some(Vector { x: 0.38, y: 0.48 });
    let mut falling = reduced.clone();
    falling.pointer = None;
    let mut normal = reduced.clone();
    normal.reduced = false;
    let before = reduced.balloons[0].position;
    for _ in 0..12 {
        reduced.step(1.0 / 60.0, DisplayFrame::default(), geometry());
        normal.step(1.0 / 60.0, DisplayFrame::default(), geometry());
        falling.step(1.0 / 60.0, DisplayFrame::default(), geometry());
    }
    assert!(reduced.balloons[0].position.x > before.x);
    assert!(reduced.balloons[0].position.y > falling.balloons[0].position.y);
    assert!(reduced.balloons[0].position.y < before.y);
    assert!(
        normal.balloons[0].position.x - before.x
            > 3.0 * (reduced.balloons[0].position.x - before.x)
    );
    reduced.pointer = Some(reduced.balloons[0].position);
    reduced.step(MAX_DT, DisplayFrame::default(), geometry());
    assert!(reduced.balloons[0].position.x.is_finite());
}

#[test]
fn tilt_is_slow_bounded_wind_and_rotates_with_the_screen() {
    let mut world = world();
    world.tilt(45.0, 0.0, 0.0);
    assert_eq!(world.target_wind, Vector { x: 0.0, y: -0.12 });
    world.tilt(0.0, 90.0, 90.0);
    assert!(world.target_wind.x.abs() < 1e-12);
    assert!((world.target_wind.y - 0.12).abs() < 1e-12);
    world.step(MAX_DT, DisplayFrame::default(), geometry());
    assert!(world.wind.y > 0.0 && world.wind.y < 0.01);
    world.tilt(f64::NAN, f64::INFINITY, 0.0);
    assert_eq!(world.target_wind, Vector::default());
}

#[test]
fn shake_is_a_short_thresholded_impulse_with_cooldown_and_no_reduced_motion() {
    let mut world = world();
    world.shake(20.0, 0.0, 0.0);
    assert_eq!(world.shake, Vector::default());
    world.reduced = false;
    world.shake(2.9, 0.0, 0.0);
    assert_eq!(world.shake, Vector::default());
    world.shake(20.0, 0.0, 90.0);
    assert!((world.shake.y + 0.3).abs() < 1e-12);
    world.shake(-20.0, 0.0, 0.0);
    assert!((world.shake.y + 0.3).abs() < 1e-12);
    world.step(MAX_DT, DisplayFrame::default(), geometry());
    assert_eq!(world.shake, Vector::default());
    assert!(world.balloons[0].velocity.y < -0.2);
    world.shake(-20.0, 0.0, 0.0);
    assert_eq!(world.shake, Vector::default());
}

#[test]
fn frame_stalls_invalid_inputs_and_long_motion_stay_bounded() {
    let mut stalled = world();
    stalled.balloons[0].velocity = Vector { x: 0.2, y: 0.3 };
    let mut bounded = stalled.clone();
    stalled.step(50.0, DisplayFrame::default(), geometry());
    bounded.step(MAX_DT, DisplayFrame::default(), geometry());
    assert_eq!(stalled.balloons, bounded.balloons);
    let unchanged = stalled.balloons.clone();
    for dt in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        stalled.step(dt, DisplayFrame::default(), geometry());
    }
    assert_eq!(stalled.balloons, unchanged);
    stalled.reduced = false;
    stalled.tilt(45.0, 45.0, 0.0);
    for i in 0..10_000 {
        stalled.shake(1000.0, -1000.0, 0.0);
        stalled.pointer = Some(Vector { x: 0.5, y: 0.5 });
        stalled.step(
            MAX_DT,
            frame(i % DISPLAY_BANDS, if i % 2 == 0 { 1.0 } else { f32::NAN }),
            geometry(),
        );
        for balloon in &stalled.balloons {
            let radius = geometry().radii(balloon);
            assert!((radius.x..=1.0 - radius.x).contains(&balloon.position.x));
            assert!((radius.y..=1.0 - radius.y).contains(&balloon.position.y));
            assert!(balloon.velocity.x.hypot(balloon.velocity.y) <= MAX_SPEED + 1e-12);
            assert!(
                balloon
                    .color
                    .iter()
                    .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
            );
        }
    }
}

#[test]
fn boundaries_reflect_outward_motion_and_keep_inward_motion() {
    let mut position = -0.1;
    let mut velocity = -0.4;
    clamp_axis(&mut position, &mut velocity, 0.1, 0.7);
    assert_eq!((position, velocity), (0.1, 0.4 * 0.7));
    position = 1.1;
    velocity = -0.4;
    clamp_axis(&mut position, &mut velocity, 0.1, 0.7);
    assert_eq!((position, velocity), (0.9, -0.4));
}

#[test]
fn rising_bar_pushes_up_and_static_contact_does_not_add_energy_or_color() {
    let mut world = world();
    over_bar(&mut world, 8, 0.3);
    let original = world.balloons[0].color;
    world.step(MAX_DT, frame(8, 0.5), geometry());
    let balloon = &world.balloons[0];
    assert_eq!(
        balloon.position.y,
        0.5 * geometry().bar_height + geometry().radii(balloon).y
    );
    assert!(balloon.velocity.y > 0.0);
    assert_ne!(balloon.color, original);
    let color = balloon.color;
    world.balloons[0].velocity = Vector::default();
    for _ in 0..120 {
        world.step(MAX_DT, frame(8, 0.5), geometry());
    }
    assert_eq!(world.balloons[0].color, color);
    assert_eq!(world.balloons[0].velocity, Vector::default());
}

#[test]
fn falling_sphere_bounces_off_a_stationary_bar_without_gaining_energy() {
    let mut world = world();
    over_bar(&mut world, 8, 0.33);
    world.previous_levels[8] = 0.325;
    world.balloons[0].velocity.y = -0.6;
    let color = world.balloons[0].color;
    world.step(MAX_DT, frame(8, 0.5), geometry());
    assert!(world.balloons[0].velocity.y > 0.0);
    assert!(world.balloons[0].velocity.y < 0.6);
    assert_ne!(world.balloons[0].color, color);
    let bottom = world.balloons[0].position.y - geometry().radii(&world.balloons[0]).y;
    assert!((0.325..0.33).contains(&bottom));
}

#[test]
fn proximity_with_a_real_gap_does_not_count_as_a_new_impact() {
    let mut world = world();
    over_bar(&mut world, 8, 0.325 + CONTACT_SLOP * 0.5);
    let before = world.balloons[0].clone();
    world.step(1.0 / 240.0, frame(8, 0.5), geometry());
    assert_eq!(world.balloons[0].color, before.color);
    assert_eq!(world.balloons[0].contacts, before.contacts);
    assert!(world.balloons[0].position.y < before.position.y);
}

#[test]
fn a_side_impact_deflects_away_and_a_gap_is_not_a_surface() {
    let mut world = world();
    let geometry = geometry();
    let radius = geometry.radii(&world.balloons[0]);
    world.balloons[0].position = Vector {
        x: geometry.bars[8].left - radius.x - 0.001,
        y: 0.2,
    };
    world.balloons[0].velocity.x = 0.3;
    world.previous_levels[8] = 0.3;
    let original = world.balloons[0].color;
    world.step(MAX_DT, frame(8, 0.6), geometry);
    assert!(world.balloons[0].position.x <= geometry.bars[8].left - radius.x);
    assert!(world.balloons[0].velocity.x < 0.0);
    assert_ne!(world.balloons[0].color, original);

    // A narrow body fits in this measured gap, independent of bar slot width.
    let mut wide_gap = geometry;
    wide_gap.bars[8].right = wide_gap.bars[8].left + 0.001;
    world.balloons[0].position.x = (wide_gap.bars[8].right + wide_gap.bars[9].left) * 0.5;
    world.balloons[0].velocity = Vector::default();
    world.balloons[0].contacts.fill(false);
    let before = world.balloons[0].clone();
    let mut levels = frame(8, 0.8);
    levels.levels[9] = 0.8;
    world.step(MAX_DT, levels, wide_gap);
    assert_eq!(world.balloons[0].position.x, before.position.x);
    assert_eq!(world.balloons[0].color, before.color);
    assert_eq!(world.balloons[0].contacts, before.contacts);
}

#[test]
fn separation_rearms_an_impact_but_continued_contact_does_not() {
    let mut world = world();
    over_bar(&mut world, 8, 0.3);
    world.step(MAX_DT, frame(8, 0.5), geometry());
    let first = world.balloons[0].color;
    world.balloons[0].velocity = Vector::default();
    world.step(MAX_DT, frame(8, 0.6), geometry());
    assert_eq!(world.balloons[0].color, first);
    world.step(MAX_DT, DisplayFrame::default(), geometry());
    world.step(MAX_DT, frame(8, 0.8), geometry());
    assert_ne!(world.balloons[0].color, first);
}

#[test]
fn nearby_bars_and_travel_across_palette_do_not_change_color() {
    let mut world = world();
    over_bar(&mut world, 8, 0.6);
    world.balloons[0].velocity.x = 0.6;
    let before = world.balloons[0].position;
    let color = world.balloons[0].color;
    for i in 0..60 {
        world.step(MAX_DT, frame(i % DISPLAY_BANDS, 0.1), geometry());
    }
    assert!(world.balloons[0].position.x > before.x + 1.0 / DISPLAY_BANDS as f64);
    assert_eq!(world.balloons[0].color, color);
    assert_eq!(world.balloons[0].contacts, [false; DISPLAY_BANDS]);
}

#[test]
fn impact_mixes_linear_light_once_with_impulse_strength_and_a_half_limit() {
    let mut balloon = world().balloons[0].clone();
    balloon.color = [1.0, 0.0, 0.0];
    balloon.impact_color([0.0, 0.0, 1.0], 10.0);
    assert_eq!(balloon.color, [0.5, 0.0, 0.5]);
    let encoded = screen_color(balloon.color.into());
    assert!((encoded.red - 0.735357).abs() < 1e-6);
    assert_eq!(encoded.red, encoded.blue);
    assert_eq!(encoded.green, 0.0);
    balloon.impact_color([0.0, 1.0, 0.0], 0.25);
    assert_eq!(balloon.color, [0.4, 0.2, 0.4]);
    balloon.impact_color([1.0, 1.0, 1.0], 0.0);
    assert_eq!(balloon.color, [0.4, 0.2, 0.4]);
}

#[test]
fn stronger_rise_and_incoming_speed_create_larger_color_shifts() {
    let run = |level, speed| {
        let mut world = world();
        over_bar(&mut world, 8, 0.3);
        world.previous_levels[8] = 0.29;
        world.balloons[0].velocity.y = speed;
        let original = world.balloons[0].color;
        world.step(MAX_DT, frame(8, level), geometry());
        original
            .into_iter()
            .zip(world.balloons[0].color)
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
    };
    assert!(run(0.6, 0.0) > run(0.5, 0.0));
    assert!(run(0.5, -0.4) > run(0.5, 0.0));
}

#[test]
fn simultaneous_hits_blend_in_ascending_bar_order() {
    let mut world = world();
    world.balloons[0].width_in_bars = 4.0;
    world.balloons[0].position = Vector { x: 0.5, y: 0.35 };
    let mut expected = world.balloons[0].clone();
    let radius = geometry().radii(&expected);
    let hits: Vec<_> = geometry()
        .bars
        .iter()
        .enumerate()
        .filter(|(_, bar)| {
            expected.position.x + radius.x >= bar.left
                && expected.position.x - radius.x <= bar.right
        })
        .map(|(i, _)| i)
        .collect();
    assert_eq!(hits, [10, 11, 12, 13]);
    // Use a normal-speed, saturated impact so each blend reaches the 50% cap.
    world.reduced = false;
    world.balloons[0].velocity.y = -1.0;
    for i in hits {
        expected.impact_color(world.palette[i], 1.0);
    }
    world.step(
        MAX_DT,
        DisplayFrame {
            levels: [1.0; DISPLAY_BANDS],
            edges: [0.0; DISPLAY_BANDS],
        },
        geometry(),
    );
    assert_eq!(world.balloons[0].color, expected.color);
    assert!(world.balloons[0].position.y - radius.y >= geometry().bar_height);
}

#[test]
fn stopping_audio_clears_sensors_and_bars_but_keeps_momentum_mouse_and_color() {
    let mut world = world();
    over_bar(&mut world, 8, 0.3);
    world.step(MAX_DT, frame(8, 0.5), geometry());
    let before = world.balloons[0].clone();
    world.pointer = Some(Vector { x: 0.5, y: 0.5 });
    world.tilt(45.0, 45.0, 0.0);
    world.clear_motion();
    assert_eq!(world.balloons[0].color, before.color);
    assert_eq!(world.balloons[0].position, before.position);
    assert_eq!(world.balloons[0].velocity, before.velocity);
    assert_eq!(world.target_wind, Vector::default());
    assert_eq!(world.pointer, Some(Vector { x: 0.5, y: 0.5 }));
    assert_eq!(world.previous_levels, [0.0; DISPLAY_BANDS]);
}

#[test]
fn sphere_collision_conserves_momentum_loses_energy_and_never_transfers_color() {
    let mut a = world().balloons[0].clone();
    let mut b = world().balloons[1].clone();
    for aspect in [0.5, 1.2, 3.0] {
        let geometry = Geometry {
            aspect,
            ..geometry()
        };
        a.position = Vector { x: 0.4, y: 0.5 };
        b.position = Vector { x: 0.401, y: 0.502 };
        a.velocity = Vector { x: 0.6, y: 0.8 };
        b.velocity = Vector { x: -0.3, y: -0.4 };
        let colors = (a.color, b.color);
        let ra = geometry.radii(&a).y;
        let rb = geometry.radii(&b).y;
        let quantities = |a: &Balloon, b: &Balloon| {
            let energy = |balloon: &Balloon, mass: f64| {
                mass * ((balloon.velocity.x * aspect).powi(2) + balloon.velocity.y.powi(2))
            };
            (
                ra * ra * a.velocity.x + rb * rb * b.velocity.x,
                ra * ra * a.velocity.y + rb * rb * b.velocity.y,
                energy(a, ra * ra) + energy(b, rb * rb),
            )
        };
        let before = quantities(&a, &b);
        assert!(collide(&mut a, &mut b, geometry, 0.7) > 0.0);
        let after = quantities(&a, &b);
        assert!((before.0 - after.0).abs() < 1e-12);
        assert!((before.1 - after.1).abs() < 1e-12);
        assert!(after.2 < before.2);
        assert_eq!((a.color, b.color), colors);
        let separation =
            ((a.position.x - b.position.x) * aspect).hypot(a.position.y - b.position.y);
        assert!((separation - ra - rb).abs() < 1e-12);
    }
}

#[test]
fn sphere_gaps_separating_contacts_and_coincident_centers_are_stable() {
    let mut a = world().balloons[0].clone();
    let mut b = world().balloons[1].clone();
    let colors = (a.color, b.color);
    let unchanged = (a.clone(), b.clone());
    assert_eq!(collide(&mut a, &mut b, geometry(), 0.7), 0.0);
    assert_eq!((a.clone(), b.clone()), unchanged);
    b.position = a.position;
    a.velocity.x = -0.2;
    b.velocity.x = 0.3;
    assert!(collide(&mut a, &mut b, geometry(), 0.7) > 0.0);
    assert_eq!((a.velocity.x, b.velocity.x), (-0.2, 0.3));
    assert!(a.position.x < b.position.x);
    assert_eq!((a.color, b.color), colors);
}

#[test]
fn fast_small_spheres_cannot_pass_through_each_other() {
    let mut world = world();
    world.reduced = false;
    for (i, balloon) in world.balloons.iter_mut().take(2).enumerate() {
        balloon.width_in_bars = 0.55;
        balloon.position = Vector {
            x: 0.4 + i as f64 * 0.05,
            y: 0.3,
        };
        balloon.velocity = Vector {
            x: if i == 0 { MAX_SPEED } else { -MAX_SPEED },
            y: 0.0,
        };
    }
    let colors = world.balloons.clone().map(|balloon| balloon.color);
    world.step(MAX_DT, DisplayFrame::default(), geometry());
    assert!(world.balloons[0].position.x < world.balloons[1].position.x);
    assert!(world.balloons[0].velocity.x < 0.0);
    assert!(world.balloons[1].velocity.x > 0.0);
    assert_eq!(world.balloons.map(|balloon| balloon.color), colors);
}

#[test]
fn gravity_forms_non_overlapping_piles_without_color_transfer() {
    for reduced in [false, true] {
        let mut world = world();
        world.reduced = reduced;
        let colors = world.balloons.clone().map(|balloon| balloon.color);
        for _ in 0..900 {
            world.step(MAX_DT, DisplayFrame::default(), geometry());
            for (i, a) in world.balloons.iter().enumerate() {
                for b in &world.balloons[i + 1..] {
                    let separation = ((a.position.x - b.position.x) * geometry().aspect)
                        .hypot(a.position.y - b.position.y);
                    let radii = geometry().radii(a).y + geometry().radii(b).y;
                    assert!(
                        separation >= radii - 0.0005,
                        "overlap {}",
                        radii - separation
                    );
                }
            }
        }
        assert_eq!(world.balloons.map(|balloon| balloon.color), colors);
    }
}

#[test]
fn a_resting_floor_contact_does_not_bounce_from_one_frame_of_gravity() {
    let mut world = world();
    world.reduced = false;
    world.tilt(45.0, 0.0, 0.0);
    let radius = geometry().radii(&world.balloons[0]);
    world.balloons[0].position.y = radius.y;
    for _ in 0..30 {
        world.step(MAX_DT, DisplayFrame::default(), geometry());
        assert_eq!(world.balloons[0].position.y, radius.y);
        assert_eq!(world.balloons[0].velocity.y, 0.0);
    }
}
