use super::*;

fn acoustic(density: [f64; BROWSER_SLICES]) -> LoudnessFrame {
    LoudnessFrame {
        sample_index: 0,
        sones: density.iter().sum::<f64>() * SLICE_BARK_WIDTH,
        specific_sones_per_bark: density,
    }
}

#[test]
fn samples_integrate_to_aggregate_and_share_one_gain_update() {
    let mut browser = VisualGain::default();
    let mut aggregate = VisualGain::default();
    for step in 0..400 {
        let frame = acoustic(core::array::from_fn(|i| {
            if step % 7 == 0 {
                0.0
            } else {
                ((i * 17 + step) % 137) as f64 * 0.03
            }
        }));
        let fine = browser.map_browser(&frame);
        let coarse = aggregate.map(&frame);
        assert_eq!(fine.bands, coarse.bands);
        for (samples, band) in fine.slices.as_chunks::<10>().0.iter().zip(fine.bands) {
            let total: f32 = samples.iter().map(|sample| sample.sones).sum();
            assert!((total - band.sones).abs() < 1e-6);
        }
    }
    // The next hardware frame also agrees: the browser did not advance twice.
    let frame = acoustic([0.2; BROWSER_SLICES]);
    assert_eq!(
        browser.map(&frame).panel_rows,
        aggregate.map(&frame).panel_rows
    );
}

#[test]
fn density_display_reaches_full_height_without_changing_measured_loudness() {
    // Every group integrates to four sones, so the adaptive gain stays at one.
    let mut density = [4.0; BROWSER_SLICES];
    density[..10].copy_from_slice(&[0.0, 0.25, 0.5, 0.75, 1.0, 2.0, 3.0, 4.0, 8.0, 20.5]);
    let levels = VisualGain::default().map_browser(&acoustic(density));
    assert_eq!(levels.bands[0].activity, 0.8);
    for (i, value) in density[..10].iter().enumerate() {
        let expected = (1.25 * value / (1.0 + value)).min(1.0) as f32;
        assert!((levels.slices[i].activity - expected).abs() < 1e-6);
        assert_eq!(levels.slices[i].sones, (value * 0.1) as f32);
    }
    assert_eq!(levels.slices[7].activity, 1.0);
    assert!(
        levels.slices[..8]
            .windows(2)
            .all(|pair| pair[0].activity < pair[1].activity)
    );
    assert!(
        VisualGain::default()
            .map_browser(&acoustic([0.0; BROWSER_SLICES]))
            .slices
            .iter()
            .all(|s| *s == BandLevel::default())
    );
}

#[test]
fn labels_are_monotonic_and_keep_integer_bark_endpoints() {
    let labels = slice_frequency_edges();
    assert!(labels.windows(2).all(|pair| pair[0] < pair[1]));
    for (group, edge) in BARK_EDGES.into_iter().enumerate() {
        assert_eq!(labels[group * 10], edge as u32);
    }
}

#[test]
fn colors_repeat_the_existing_palette_without_local_drift() {
    let colors = slice_colors(90.0, 58.0);
    let palette = Gradient::<24>::new_rainbow(90.0, 58.0);
    for (group, samples) in colors.as_chunks::<10>().0.iter().enumerate() {
        assert!(samples.iter().all(|color| *color == palette.colors[group]));
    }
}

fn motion_levels(a: f32, b: f32, group: f32) -> BrowserLevels {
    let mut slices = [BandLevel::default(); BROWSER_SLICES];
    slices[0] = BandLevel {
        activity: a,
        sones: a,
    };
    slices[1] = BandLevel {
        activity: b,
        sones: b,
    };
    let mut bands = [BandLevel::default(); DISPLAY_BANDS];
    bands[0] = BandLevel {
        activity: group,
        sones: group,
    };
    BrowserLevels { slices, bands }
}

#[test]
fn independent_falls_and_group_maximum_keep_aggregate_attack_and_physics() {
    for reduced in [false, true] {
        let mut snapshot = BrowserSnapshot::new(0.0);
        snapshot.push(0.0, motion_levels(0.9, 0.5, 0.4), reduced);
        snapshot.push(0.1, motion_levels(0.0, 0.5, 0.4), reduced);
        let early = snapshot.frame(0.3);
        assert_eq!(early.slices[..2], [0.9, 0.5]);
        let late = snapshot.frame(1.5);
        assert!(late.slices[0] < 0.5);
        assert_eq!(late.slices[1], 0.5);
        assert_eq!(late.group_heights[0], 0.5);
        assert_eq!(late.bands.levels[0], 0.4);
        assert_eq!(late.bands.edges[0], 0.0);
        // A new fine peak does not invent an aggregate attack.
        snapshot.push(1.5, motion_levels(1.0, 0.5, 0.4), reduced);
        assert_eq!(snapshot.frame(1.5).group_heights[0], 1.0);
        assert_eq!(snapshot.frame(1.5).bands.edges[0], 0.0);
        snapshot.push(1.6, motion_levels(1.0, 0.5, 0.6), reduced);
        assert_eq!(snapshot.frame(1.6).bands.edges[0], 1.0);
        snapshot.push(1.7, motion_levels(0.0, 0.0, 0.0), reduced);
        assert_eq!(snapshot.frame(10.0), BrowserFrame::default());
    }
}

#[test]
fn reduced_motion_slows_each_fall() {
    let mut normal = BrowserSnapshot::new(0.0);
    let mut reduced = BrowserSnapshot::new(0.0);
    for (state, flag) in [(&mut normal, false), (&mut reduced, true)] {
        state.push(0.0, motion_levels(0.9, 0.4, 0.5), flag);
        state.push(0.1, motion_levels(0.0, 0.0, 0.0), flag);
    }
    for i in 0..2 {
        assert!(reduced.frame(0.8).slices[i] > normal.frame(0.8).slices[i]);
    }
}

#[test]
fn transport_round_trip_keeps_exact_aggregate_prefix_and_rejects_invalid_data() {
    let mut state = BrowserSnapshot::new(0.0);
    state.push(0.5, motion_levels(0.8, 0.3, 0.4), true);
    let mut data = [0.0; BrowserSnapshot::TRANSPORT_LEN];
    state.write_transport(&mut data);
    assert_eq!(data.len(), 1588);
    assert_eq!(BrowserSnapshot::from_transport(&data), Some(state));
    let mut aggregate = DisplaySnapshot::<24>::new(0.0);
    aggregate.push(0.5, motion_levels(0.8, 0.3, 0.4).bands, true);
    let mut prefix = [0.0; 146];
    aggregate.write_transport(&mut prefix);
    assert_eq!(data[..146], prefix);
    assert!(BrowserSnapshot::from_transport(&prefix).is_none());
    assert!(BrowserSnapshot::from_transport(&data[..1587]).is_none());
    // Both halves use the same strict motion format, including finite values.
    for index in 0..data.len() {
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut bad = data;
            bad[index] = invalid;
            assert!(
                BrowserSnapshot::from_transport(&bad).is_none(),
                "index {index}"
            );
        }
    }
    for (index, value) in [
        (146, 0.6),
        (147, 0.0),
        (148, 1.1),
        (149, -1.0),
        (150, -1.0),
        (151, 1.1),
        (152, -0.1),
        (153, -0.1),
    ] {
        let mut bad = data;
        bad[index] = value;
        assert!(
            BrowserSnapshot::from_transport(&bad).is_none(),
            "index {index}"
        );
    }
}
