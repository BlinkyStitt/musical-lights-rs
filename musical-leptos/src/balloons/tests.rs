use super::*;

fn world() -> BalloonWorld {
    let mut world = BalloonWorld::new(Gradient::new_rainbow(90.0, 58.0));
    world.reduced = true; // Disable float to isolate contacts and external forces.
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
    for (i, balloon) in first.balloons.iter().enumerate() {
        assert_eq!(balloon.color, first.palette[(i * 7 + 5) % DISPLAY_BANDS]);
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
    let mut normal = reduced.clone();
    normal.reduced = false;
    let before = reduced.balloons[0].position;
    for _ in 0..30 {
        reduced.step(1.0 / 60.0, DisplayFrame::default(), geometry());
        normal.step(1.0 / 60.0, DisplayFrame::default(), geometry());
    }
    assert!(reduced.balloons[0].position.x > before.x);
    assert!(reduced.balloons[0].position.y > before.y);
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
fn boundary_clamps_cancel_only_outward_velocity() {
    let mut position = -0.1;
    let mut velocity = -0.4;
    clamp_axis(&mut position, &mut velocity, 0.1);
    assert_eq!((position, velocity), (0.1, 0.0));
    position = 1.1;
    velocity = -0.4;
    clamp_axis(&mut position, &mut velocity, 0.1);
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
fn static_contact_from_a_falling_balloon_prevents_penetration_without_recolor() {
    let mut world = world();
    over_bar(&mut world, 8, 0.33);
    world.previous_levels[8] = 0.325;
    world.balloons[0].velocity.y = -0.6;
    let color = world.balloons[0].color;
    world.step(MAX_DT, frame(8, 0.5), geometry());
    assert_eq!(world.balloons[0].velocity.y, 0.0);
    assert_eq!(world.balloons[0].color, color);
    assert_eq!(
        world.balloons[0].position.y - geometry().radii(&world.balloons[0]).y,
        0.325
    );
}

#[test]
fn proximity_with_a_real_gap_does_not_count_as_a_new_impact() {
    let mut world = world();
    over_bar(&mut world, 8, 0.325 + CONTACT_SLOP * 0.5);
    let before = world.balloons[0].clone();
    world.step(MAX_DT, frame(8, 0.5), geometry());
    assert_eq!(world.balloons[0], before);
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
    assert_eq!(
        world.balloons[0].position.x,
        geometry.bars[8].left - radius.x
    );
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
    assert_eq!(world.balloons[0], before);
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
    for i in hits {
        expected.impact_color(world.palette[i], 0.7);
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
fn stop_clears_input_and_velocity_but_preserves_color_and_position() {
    let mut world = world();
    over_bar(&mut world, 8, 0.3);
    world.step(MAX_DT, frame(8, 0.5), geometry());
    let before = world.balloons[0].clone();
    world.pointer = Some(Vector { x: 0.5, y: 0.5 });
    world.tilt(45.0, 45.0, 0.0);
    world.clear_input();
    assert_eq!(world.balloons[0].color, before.color);
    assert_eq!(world.balloons[0].position, before.position);
    assert_eq!(world.balloons[0].velocity, Vector::default());
    assert_eq!(world.target_wind, Vector::default());
    assert_eq!(world.pointer, None);
    assert_eq!(world.previous_levels, [0.0; DISPLAY_BANDS]);
}
