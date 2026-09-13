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
        baseline: 0.0,
    }
}

#[test]
fn bounded_vectors_preserve_direction_and_handle_extreme_finite_inputs() {
    for vector in [
        Vector::default(),
        Vector { x: 0.1, y: -0.2 },
        Vector { x: 3.0, y: 4.0 },
        Vector {
            x: -1e308,
            y: 1e308,
        },
        Vector {
            x: 1e-310,
            y: -1e-310,
        },
    ] {
        let bounded = vector.bounded(MAX_SPEED);
        assert!(bounded.x.is_finite() && bounded.y.is_finite());
        assert!(bounded.x.hypot(bounded.y) <= MAX_SPEED + 1e-14);
        if vector.x.hypot(vector.y) <= MAX_SPEED {
            assert_eq!(bounded, vector);
        } else {
            assert!((bounded.x.hypot(bounded.y) - MAX_SPEED).abs() < 1e-14);
            assert!((bounded.x / bounded.y - vector.x / vector.y).abs() < 1e-14);
        }
    }
}

#[test]
fn free_space_gravity_covers_visible_distance_in_half_a_second() {
    for (reduced, minimum) in [(false, 0.5), (true, 0.1)] {
        let mut world = world();
        world.reduced = reduced;
        // Keep the measured sphere far from the floor and every other body.
        world.balloons[0].position = Vector { x: 0.04, y: 0.9 };
        for (i, other) in world.balloons.iter_mut().enumerate().skip(1) {
            other.width_in_bars = 0.1;
            other.position = Vector {
                x: 0.3 + i as f64 * 0.05,
                y: 0.1,
            };
        }
        for _ in 0..30 {
            world.step(1.0 / 60.0, DisplayFrame::default(), geometry());
        }
        let distance = 0.9 - world.balloons[0].position.y;
        assert!(
            distance >= minimum,
            "reduced={reduced}, distance={distance}"
        );
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
    // Check after the apex and before the faster second floor impact.
    for _ in 0..12 {
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
            > 4.0 * (initial - reduced.balloons[0].position.y)
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
        [
            0.55, 1.4, 2.2, 0.8, 3.1, 1.0, 4.0, 1.8, 0.65, 2.6, 1.2, 3.5, 0.65, 1.0, 1.2, 0.8, 1.4,
            0.55, 0.7, 1.1, 1.6, 0.9, 1.3, 0.6
        ]
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
            assert!(
                (radius.x - 1e-7..=1.0 - radius.x + 1e-7).contains(&balloon.position.x),
                "horizontal bounds: {balloon:?}"
            );
            assert!(
                (radius.y - 1e-7..=1.0 - radius.y + 1e-7).contains(&balloon.position.y),
                "vertical bounds: {balloon:?}"
            );
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
    let mut ball = world().balloons[0].clone();
    ball.position = Vector { x: -0.01, y: 0.5 };
    ball.velocity.x = -0.4;
    let color = ball.color;
    constrain_walls(&mut ball, geometry(), 0.7);
    assert!((ball.position.x - geometry().radii(&ball).x).abs() < 1e-12);
    assert!((ball.velocity.x - 0.4 * 0.7).abs() < 1e-12);
    assert!(ball.deformation.x < 1.0);
    ball.position.x = 1.01;
    ball.velocity.x = -0.4;
    constrain_walls(&mut ball, geometry(), 0.7);
    assert!((ball.position.x + geometry().radii(&ball).x - 1.0).abs() < 1e-12);
    assert_eq!(ball.velocity.x, -0.4);
    assert_eq!(ball.color, color);
}

#[test]
fn a_fast_rise_cannot_pass_through_balls_above_rounded_corners() {
    let mut geometry = geometry();
    geometry.aspect = 1.8;
    geometry.bars = std::array::from_fn(|i| Bar {
        left: i as f64 / 24.0,
        right: (i as f64 + 0.95) / 24.0,
    });
    let mut world = world();
    let mut frame = DisplayFrame::default();
    frame.levels.fill(1.0);
    world.step(1.0 / 60.0, frame, geometry);
    for ball in &world.balloons {
        // A compressed body can fit through a real gap. It must remain outside
        // every solid bar, including each rounded cap.
        for bar in geometry.bars {
            let hit = bar_contact(
                ball.position,
                geometry.radii(ball),
                bar,
                geometry.bar_height,
                geometry,
                false,
                0.0,
            );
            assert!(
                hit.is_none_or(|hit| hit.depth < CONTACT_SLOP),
                "body inside rising bar: {ball:?}, contact={hit:?}"
            );
        }
    }
}

#[test]
fn narrow_gaps_do_not_leave_compressed_bodies_inside_bars() {
    let geometry = Geometry {
        bars: std::array::from_fn(|i| Bar {
            left: i as f64 / 24.0,
            right: (i as f64 + 0.95) / 24.0,
        }),
        bar_height: 0.95,
        aspect: 3.0,
        ..geometry()
    };
    let mut world = world();
    let mut frame = DisplayFrame::default();
    frame.levels.fill(1.0);
    for _ in 0..120 {
        world.step(1.0 / 60.0, frame, geometry);
        for ball in &world.balloons {
            for bar in geometry.bars {
                let hit = bar_contact(
                    ball.position,
                    geometry.radii(ball),
                    bar,
                    geometry.bar_height,
                    geometry,
                    false,
                    0.0,
                );
                assert!(
                    hit.is_none_or(|hit| hit.depth < CONTACT_SLOP),
                    "compressed body inside a bar: {ball:?}, contact={hit:?}"
                );
            }
        }
    }
}

#[test]
fn a_ball_compresses_above_a_full_height_bar_and_recovers() {
    let geometry = Geometry {
        bar_height: 0.95,
        aspect: 3.0,
        ..geometry()
    };
    let mut world = world();
    // Isolate compression between a raised bar and the ceiling. The crowded
    // case above separately checks all 24 bars and their real gaps.
    over_bar(&mut world, 8, 0.5);
    world.balloons[0].width_in_bars = 4.0;
    for (i, other) in world.balloons.iter_mut().enumerate().skip(1) {
        other.width_in_bars = 0.05;
        other.position = Vector {
            x: 0.6 + i as f64 * 0.014,
            y: 0.1,
        };
    }
    world.step(1.0 / 60.0, frame(8, 1.0), geometry);
    let ball = &world.balloons[0];
    let radius = geometry.radii(ball);
    assert!(ball.position.y + radius.y <= 1.0 + 1e-6);
    assert!(
        ball.position.y - radius.y >= geometry.bar_height - CONTACT_SLOP,
        "bar clearance {}, ball {ball:?}",
        ball.position.y - radius.y - geometry.bar_height
    );
    let compressed = ball.deformation.y;
    assert!(compressed < 0.3);
    let colors = world.balloons.clone().map(|ball| ball.color);
    for _ in 0..120 {
        world.step(1.0 / 60.0, DisplayFrame::default(), geometry);
    }
    assert!(world.balloons[0].deformation.y > compressed + 0.3);
    assert_eq!(world.balloons.map(|ball| ball.color), colors);
}

#[test]
fn rising_bar_pushes_up_and_static_contact_does_not_add_energy_or_color() {
    let mut world = world();
    over_bar(&mut world, 8, 0.3);
    let original = world.balloons[0].color;
    world.step(MAX_DT, frame(8, 0.5), geometry());
    let balloon = &world.balloons[0];
    assert!(
        (balloon.position.y - 0.5 * geometry().bar_height - geometry().radii(balloon).y).abs()
            < 1e-12
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
    world.reduced = false;
    let geometry = geometry();
    for (i, other) in world.balloons.iter_mut().enumerate().skip(1) {
        other.width_in_bars = 0.05;
        other.position = Vector {
            x: 0.6 + i as f64 * 0.014,
            y: 0.1,
        };
    }
    // A circle centered over the gap touches the two facing rounded caps.
    // Outer bars do not collide just because they enter its bounding box.
    world.balloons[0].width_in_bars = 1.0;
    let radius = geometry.radii(&world.balloons[0]).y;
    let corner =
        (geometry.bars[11].right - geometry.bars[11].left) * geometry.aspect * BAR_CORNER_RATIO;
    let x = (geometry.bars[11].right + geometry.bars[12].left) * 0.5;
    let dx = (x - geometry.bars[11].right) * geometry.aspect + corner;
    let top = 0.4;
    world.balloons[0].position = Vector {
        x,
        y: top - corner + ((radius + corner).powi(2) - dx.powi(2)).sqrt(),
    };
    world.balloons[0].velocity.y = -3.0;
    let mut levels = [0.0; DISPLAY_BANDS];
    levels[11] = top;
    levels[12] = top;
    world.previous_levels = levels;
    let mut expected = world.balloons[0].clone();
    expected.impact_color(world.palette[11], 1.0);
    expected.impact_color(world.palette[12], 1.0);
    world.advance(1.0 / 240.0, levels, geometry);
    assert_eq!(world.balloons[0].color, expected.color);
    assert_eq!(
        world.balloons[0]
            .contacts
            .iter()
            .enumerate()
            .filter_map(|(i, hit)| hit.then_some(i))
            .collect::<Vec<_>>(),
        [11, 12]
    );
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
    for aspect in [0.5, 1.2, 3.0] {
        let mut a = world().balloons[0].clone();
        let mut b = world().balloons[1].clone();
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
        for _ in 0..8 {
            collide(&mut a, &mut b, geometry, 0.7);
        }
        assert!(body_contact(&a, &b, geometry).is_none_or(|hit| hit.depth < 1e-8));
        assert!(a.deformation.x < 1.0 || a.deformation.y < 1.0);
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
fn capsule_contacts_distinguish_round_ends_from_bounding_boxes() {
    let geometry = Geometry {
        aspect: 1.0,
        ..geometry()
    };
    let mut a = world().balloons[0].clone();
    a.width_in_bars = 6.4; // Resting radius 0.1 in these measured bar bounds.
    a.position = Vector { x: 0.3, y: 0.3 };
    a.deformation = Vector { x: 2.0, y: 1.0 };
    let mut b = a.clone();
    b.deformation = Vector { x: 1.0, y: 2.0 };
    b.position = Vector { x: 0.55, y: 0.55 };
    assert!(body_contact(&a, &b, geometry).is_none());
    b.position = Vector { x: 0.5, y: 0.5 };
    let hit = body_contact(&a, &b, geometry).unwrap();
    assert!((hit.depth - (0.2 - 0.1 * 2.0_f64.sqrt())).abs() < 1e-12);
    assert!((hit.normal.x - 0.5_f64.sqrt()).abs() < 1e-12);
    assert!((hit.normal.y - hit.normal.x).abs() < 1e-12);
}

#[test]
fn a_compressed_free_body_recovers_without_recoloring() {
    let mut world = world();
    world.balloons[0].position = Vector { x: 0.04, y: 0.85 };
    world.balloons[0].deformation = Vector { x: 1.1, y: 0.3 };
    for (i, other) in world.balloons.iter_mut().enumerate().skip(1) {
        other.width_in_bars = 0.1;
        other.position = Vector {
            x: 0.3 + i as f64 * 0.025,
            y: 0.2,
        };
    }
    let color = world.balloons[0].color;
    for _ in 0..25 {
        world.step(1.0 / 120.0, DisplayFrame::default(), geometry());
    }
    let ball = &world.balloons[0];
    assert!(ball.deformation.y > 0.75 && ball.deformation.y < 1.0);
    assert!(ball.position.y > 0.7);
    assert_eq!(ball.contacts, [false; DISPLAY_BANDS]);
    assert_eq!(ball.color, color);
}

#[test]
fn fast_compressed_bodies_cannot_cross_between_integration_steps() {
    let mut world = world();
    world.reduced = false;
    for (i, other) in world.balloons.iter_mut().enumerate().skip(2) {
        other.width_in_bars = 0.05;
        other.position = Vector {
            x: 0.6 + i as f64 * 0.014,
            y: 0.1,
        };
    }
    for (i, ball) in world.balloons.iter_mut().take(2).enumerate() {
        ball.width_in_bars = 1.0;
        ball.deformation = Vector { x: 0.001, y: 1.0 };
        ball.position = Vector {
            x: 0.4 + i as f64 * 0.005,
            y: 0.6,
        };
        ball.velocity.x = if i == 0 { 0.6 } else { -0.6 };
    }
    let colors = (world.balloons[0].color, world.balloons[1].color);
    world.step(1.0 / 60.0, DisplayFrame::default(), geometry());
    let [a, b, ..] = &world.balloons;
    assert!(a.position.x < b.position.x);
    assert!(a.velocity.x < 0.0 && b.velocity.x > 0.0);
    assert_eq!((a.color, b.color), colors);
}

#[test]
fn capsule_sweeps_detect_rounded_corner_crossings_and_reject_misses() {
    let geometry = Geometry {
        aspect: 1.0,
        ..geometry()
    };
    let mut a = world().balloons[0].clone();
    a.width_in_bars = 6.4;
    a.deformation = Vector { x: 2.0, y: 1.0 };
    a.position = Vector { x: 0.3, y: 0.3 };
    let mut b = a.clone();
    b.deformation = Vector { x: 1.0, y: 2.0 };
    let before = Vector { x: 0.55, y: 0.55 };
    b.position = Vector { x: 0.05, y: 0.05 };
    assert!(body_contact(&a, &b, geometry).is_none());
    let hit = swept_body_contact(&a, &b, a.position, before, geometry).unwrap();
    assert!((hit.normal.x - 0.5_f64.sqrt()).abs() < 1e-12);
    assert!((hit.normal.y - hit.normal.x).abs() < 1e-12);
    b.position = Vector { x: 0.65, y: 0.55 };
    assert!(swept_body_contact(&a, &b, a.position, before, geometry).is_none());
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
                    let overlap = body_contact(a, b, geometry()).map_or(0.0, |hit| hit.depth);
                    assert!(overlap <= 0.0005, "overlap {overlap}");
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
    world.balloons[0].position = Vector {
        x: 0.03,
        y: radius.y,
    };
    // Test floor rest in free space, without a falling neighbor hitting it.
    for (i, other) in world.balloons.iter_mut().enumerate().skip(1) {
        other.width_in_bars = 0.1;
        other.position.x = 0.3 + i as f64 * 0.05;
    }
    for _ in 0..30 {
        world.step(MAX_DT, DisplayFrame::default(), geometry());
        let ball = &world.balloons[0];
        assert!((ball.position.y - geometry().radii(ball).y).abs() < 1e-12);
        assert_eq!(world.balloons[0].velocity.y, 0.0);
    }
}

#[test]
fn rounded_caps_deflect_falling_balls_outward_with_mirrored_impulses() {
    let geometry = geometry();
    let bar = geometry.bars[8];
    let top = 0.6_f32 as f64 * geometry.bar_height;
    let corner = (bar.right - bar.left) * geometry.aspect * BAR_CORNER_RATIO;
    let mut velocities = Vec::new();
    for side in [-1.0, 1.0] {
        let mut world = world();
        world.reduced = false;
        for (i, other) in world.balloons.iter_mut().enumerate().skip(1) {
            other.width_in_bars = 0.05;
            other.position = Vector {
                x: 0.6 + i as f64 * 0.014,
                y: 0.1,
            };
        }
        let radius = geometry.radii(&world.balloons[0]).y;
        let center = if side < 0.0 {
            bar.left + corner / geometry.aspect
        } else {
            bar.right - corner / geometry.aspect
        };
        world.balloons[0].position = Vector {
            x: center + side * 0.7 * (corner + radius) / geometry.aspect,
            y: top - corner + 0.7 * (corner + radius) + 0.001,
        };
        world.balloons[0].velocity.y = -1.0;
        world.previous_levels[8] = top;
        let color = world.balloons[0].color;
        world.step(1.0 / 240.0, frame(8, 0.6), geometry);
        let ball = &world.balloons[0];
        assert!(
            ball.velocity.x * side > 0.2,
            "corner must throw the ball outward: {:?}",
            ball.velocity
        );
        assert_ne!(ball.color, color);
        assert!((ball.velocity.x * geometry.aspect).hypot(ball.velocity.y) < 1.03);
        velocities.push(ball.velocity);
    }
    assert!((velocities[0].x + velocities[1].x).abs() < 1e-10);
    assert!((velocities[0].y - velocities[1].y).abs() < 1e-10);
}
