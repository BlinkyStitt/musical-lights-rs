//! Hardware-neutral visual prototype calculations. SI inputs for drag, column
//! units for scrolling, linear RGB for pigments; no engine, heap, or browser APIs.
use num::Float;

/// Average absolute travel at 120 BPM: two columns per beat.
pub const SCROLL_SPEED: f64 = 4.0;
pub const SCROLL_EASE: f64 = 0.120;
pub const SCROLL_PEAK_SPEED: f64 = SCROLL_SPEED;

/// Two equal inward strokes share the room and leave the requested free space.
/// Hardware can use the same geometry with physical mirrors; no rendering APIs.
pub fn paired_bar_extent(height: f32, reserved: f32) -> f32 {
    if !height.is_finite() || !reserved.is_finite() {
        return 0.0;
    }
    (height.max(0.0) - reserved.max(0.0)).max(0.0) * 0.5
}

/// Allocation-free direction policy. Defaults: 5% at 60 BPM, 50% at 200 BPM.
/// The curve is an exponent: 1 is linear, >1 delays the increase, <1 advances it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DirectionOdds {
    values: [f64; 5],
}
impl Default for DirectionOdds {
    fn default() -> Self {
        Self {
            values: [60.0, 200.0, 0.05, 0.5, 1.0],
        }
    }
}
impl DirectionOdds {
    pub fn values(self) -> [f64; 5] {
        self.values
    }
    pub fn new(values: [f64; 5]) -> Result<Self, &'static str> {
        let [slow, fast, low, high, curve] = values;
        if !values.iter().all(|v| v.is_finite())
            || !(60.0..=200.0).contains(&slow)
            || !(60.0..=200.0).contains(&fast)
            || slow >= fast
            || !(0.0..=1.0).contains(&low)
            || !(low..=1.0).contains(&high)
            || !(0.25..=4.0).contains(&curve)
        {
            return Err("Invalid direction probability curve");
        }
        Ok(Self { values })
    }
    pub fn probability(self, bpm: f64) -> f64 {
        if !bpm.is_finite() {
            return 0.0;
        }
        let [slow, fast, low, high, curve] = self.values;
        let t = ((bpm.clamp(60.0, 200.0) - slow) / (fast - slow)).clamp(0.0, 1.0);
        low + (high - low) * Float::powf(t, curve)
    }
}

/// Silent display preview, independent of measured audio and attack envelopes.
/// A travelling sine covers every column; callers replace it when audio starts.
pub fn idle_wave(column: usize, columns: usize, seconds: f64, reduced: bool) -> f64 {
    if columns == 0 || !seconds.is_finite() {
        return 0.0;
    }
    let (period, amplitude) = if reduced { (12.0, 0.15) } else { (6.0, 0.3) };
    0.45 + amplitude
        * Float::sin(core::f64::consts::TAU * (column as f64 / columns as f64 - seconds / period))
}

/// Sustained light on the rising side of a visual wave. Equal-height display
/// frames retain the direction; a smooth release follows the falling side.
#[derive(Clone, Copy, Default)]
pub struct WaveLight {
    previous: Option<(f32, f64)>,
    rising: bool,
    intensity: f32,
}
impl WaveLight {
    pub fn sample(&mut self, height: f32, maximum: f32, seconds: f64, enabled: bool) -> f32 {
        if !enabled
            || !height.is_finite()
            || !maximum.is_finite()
            || maximum <= 0.0
            || !seconds.is_finite()
        {
            *self = Self::default();
            return 0.0;
        }
        let height = height.clamp(0.0, maximum);
        let dt = if let Some((previous, at)) = self.previous {
            if seconds < at {
                *self = Self::default();
                self.previous = Some((height, seconds));
                return 0.0;
            }
            if height > previous {
                self.rising = true;
            } else if height < previous {
                self.rising = false;
            }
            (seconds - at).min(0.1)
        } else {
            0.0
        };
        self.previous = Some((height, seconds));
        let target = if self.rising { height / maximum } else { 0.0 };
        self.intensity += (target - self.intensity) * (-Float::exp_m1(-dt / 0.18)) as f32;
        self.intensity
    }
}

/// Decorative microphone-listening floor, separate from measured loudness.
/// One sixth of bar travel at most; louder audio replaces it. No attack cues.
pub fn listening_level(level: f32, column: usize, seconds: f64, reduced: bool) -> f32 {
    if reduced || !seconds.is_finite() {
        return level;
    }
    let phase = core::f64::consts::TAU * (column as f64 / 24.0 - (seconds % 6.0) / 6.0);
    level.max(((1.0 + Float::sin(phase)) / 12.0) as f32)
}

/// Implicit quadratic sphere drag: Cd=0.47, rho=1.225 kg/m³. Multiplier always
/// stays in [0,1], including very fast velocities and large time steps.
pub fn sphere_drag_factor(radius: f32, speed: f32, mass: f32, dt: f32) -> f32 {
    if ![radius, speed, mass, dt].iter().all(|v| v.is_finite())
        || radius <= 0.0
        || mass <= 0.0
        || dt <= 0.0
    {
        return 1.0;
    }
    let coefficient = 0.5 * 1.225 * 0.47 * core::f32::consts::PI * radius * radius;
    1.0 / (1.0 + coefficient * speed.max(0.0) * dt / mass)
}

/// Strength of a qualified physical light contact. Callers apply the audio
/// policy and exclude persistent resting pressure.
pub fn contact_pigment_blend(impulse: f32, mass: f32) -> f32 {
    if ![impulse, mass].iter().all(|v| v.is_finite()) || impulse <= 0.0 || mass <= 0.0 {
        return 0.0;
    }
    (impulse / mass * 0.15).clamp(0.0, 0.5)
}

/// Shared shape and blend edges for the three soft swirl regions. Rendering
/// uses this profile; contact injection uses the same ball-local surface point.
pub const PIGMENT_SWIRL: [f32; 7] = [7.0, 3.0, 3.0, 4.0, -0.85, 0.15, 0.9];

/// A new contact paints in silence. Active audio requires a qualified attack;
/// a new attack can also light a bar that already supports the ball.
pub fn pigment_contact_eligible(
    attack_required: bool,
    attack: f32,
    new_contact: bool,
    new_attack: bool,
) -> bool {
    (0.0..=1.0).contains(&attack)
        && (!attack_required || attack > 0.0)
        && (new_contact || (attack_required && new_attack))
}

/// Soft material weights at a unit point on the rolling ball.
pub fn pigment_weights(point: [f32; 3]) -> [f32; 3] {
    if !point.iter().all(|v| v.is_finite()) {
        return [0.0; 3];
    }
    let [y_rate, bend, x_rate, z_rate, low, middle, high] = PIGMENT_SWIRL;
    let wave =
        Float::sin(y_rate * point[1] + bend * Float::sin(x_rate * point[0]) + z_rate * point[2]);
    let smooth = |a: f32, b: f32| {
        let t = ((wave - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let first = smooth(low, middle);
    let second = smooth(middle, high);
    [
        (1.0 - first) * (1.0 - second),
        first * (1.0 - second),
        second,
    ]
}

/// Inject contacted light into its soft swirl regions. Other regions retain
/// their colors; a global target must not turn the whole ball into one color.
pub fn paint_pigment(targets: &mut [f32; 9], color: [f32; 3], point: [f32; 3], blend: f32) {
    if !(0.0..=1.0).contains(&blend)
        || !targets
            .iter()
            .chain(color.iter())
            .all(|v| (0.0..=1.0).contains(v))
    {
        return;
    }
    for (region, weight) in pigment_weights(point).into_iter().enumerate() {
        for c in 0..3 {
            let target = &mut targets[region * 3 + c];
            *target += (color[c] - *target) * blend * weight;
        }
    }
}

/// Each visible region reaches 95% of a held target in approximately 0.54 s.
pub const PIGMENT_FILL_SECONDS: f32 = 0.18;

/// Ease visible light toward each region's own target. The exact exponential
/// solution makes fill independent of callbacks, contact substeps and rendering.
pub fn advance_pigment(surface: &mut [f32; 9], targets: &[f32; 9], dt: f32) {
    if !dt.is_finite()
        || dt <= 0.0
        || !surface
            .iter()
            .chain(targets.iter())
            .all(|v| (0.0..=1.0).contains(v))
    {
        return;
    }
    let blend = 1.0 - Float::exp(-(dt / PIGMENT_FILL_SECONDS).min(60.0));
    for (value, target) in surface.iter_mut().zip(targets) {
        *value += (*target - *value) * blend;
    }
}

/// Weighted mean of the soft swirl regions. Keep lighting on the
/// visible fill rather than jumping to the new contact target.
pub fn pigment_color(surface: &[f32; 9]) -> [f32; 3] {
    core::array::from_fn(|c| {
        surface[3 + c]
            + 0.25 * (surface[c] - surface[3 + c])
            + 0.25 * (surface[6 + c] - surface[3 + c])
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn wave_light_holds_rising_bars_and_releases_falling_bars_at_all_frame_rates() {
        for fps in [30, 60, 120] {
            let mut light = WaveLight::default();
            assert_eq!(light.sample(0.1, 0.2, 0.0, true), 0.0);
            for frame in 1..=fps {
                let at = f64::from(frame) / f64::from(fps);
                light.sample(0.1 + at as f32 * 0.1, 0.2, at, true);
            }
            let rising = light.intensity;
            assert!(rising > 0.85);
            for frame in 1..=fps {
                let at = 1.0 + f64::from(frame) / f64::from(fps);
                let held = light.sample(0.2, 0.2, at, true);
                assert!(held >= rising);
                assert_eq!(light.sample(0.2, 0.2, at, true), held);
            }
            assert!(light.intensity > 0.99);
            let mut previous = light.intensity;
            for frame in 1..=fps {
                let dt = f64::from(frame) / f64::from(fps);
                let falling = light.sample(0.2 - dt as f32 * 0.1, 0.2, 2.0 + dt, true);
                assert!(falling < previous && previous - falling < 0.18);
                previous = falling;
            }
            assert!(light.intensity < 0.004);
            assert_eq!(light.sample(0.2, 0.2, 4.0, false), 0.0);
            assert_eq!(light.sample(f32::NAN, 0.2, 5.0, true), 0.0);
        }
    }
    #[test]
    fn listening_floor_is_small_travelling_and_separate_from_louder_audio() {
        for band in 0..24 {
            let level = listening_level(0.0, band, 0.0, false);
            assert!((0.0..=1.0 / 6.0).contains(&level));
            assert_eq!(listening_level(0.7, band, 0.0, false), 0.7);
            assert_eq!(listening_level(0.0, band, 3.0, true), 0.0);
            assert!((level - listening_level(0.0, (band + 6) % 24, 1.5, false)).abs() < 1e-7);
        }
        assert_eq!(listening_level(0.5, 0, f64::NAN, false), 0.5);
    }
    use super::*;
    #[test]
    fn paired_strokes_leave_the_reserved_room() {
        let extent = paired_bar_extent(0.6, 0.24);
        assert!((extent * 2.0 + 0.24 - 0.6).abs() < 1e-6);
        assert_eq!(paired_bar_extent(0.1, 0.2), 0.0);
        assert_eq!(paired_bar_extent(f32::NAN, 0.0), 0.0);
    }
    #[test]
    fn direction_chance_scales_with_bounded_music_tempo() {
        for (bpm, expected) in [
            (0.0, 0.05),
            (60.0, 0.05),
            (130.0, 0.275),
            (200.0, 0.5),
            (999.0, 0.5),
        ] {
            assert!((DirectionOdds::default().probability(bpm) - expected).abs() < 1e-12);
        }
        assert_eq!(DirectionOdds::default().probability(f64::NAN), 0.0);
    }
    #[test]
    fn direction_curves_preserve_endpoints_and_reject_invalid_settings() {
        for exponent in [0.25, 1.0, 4.0] {
            let odds = DirectionOdds::new([80.0, 180.0, 0.1, 0.7, exponent]).unwrap();
            assert_eq!(odds.probability(60.0), 0.1);
            assert_eq!(odds.probability(200.0), 0.7);
            assert!(
                (odds.probability(130.0) - (0.1 + 0.6 * Float::powf(0.5, exponent))).abs() < 1e-12
            );
        }
        for settings in [
            [200.0, 60.0, 0.05, 0.5, 1.0],
            [60.0, 201.0, 0.05, 0.5, 1.0],
            [60.0, 200.0, 0.6, 0.5, 1.0],
            [60.0, 200.0, 0.05, 0.5, 0.0],
        ] {
            assert!(DirectionOdds::new(settings).is_err());
        }
    }
    #[test]
    fn idle_wave_covers_all_columns_and_travels_smoothly() {
        for column in 0..24 {
            let a = idle_wave(column, 24, 0.0, false);
            assert!((0.149..=0.751).contains(&a));
            assert!((a - idle_wave((column + 1) % 24, 24, 0.0, false)).abs() < 0.08);
            assert!((a - idle_wave(column, 24, 6.0, false)).abs() < 1e-12);
            assert!((0.299..=0.601).contains(&idle_wave(column, 24, 0.0, true)));
        }
        assert!((idle_wave(6, 24, 0.0, false) - 0.75).abs() < 1e-12);
        assert!((idle_wave(12, 24, 1.5, false) - 0.75).abs() < 1e-12);
        assert_eq!(idle_wave(0, 0, 0.0, false), 0.0);
    }
    #[test]
    fn drag_is_stable_and_depends_on_size_and_speed() {
        assert_eq!(sphere_drag_factor(0.1, 0.0, 1.0, 0.01), 1.0);
        let slow = sphere_drag_factor(0.1, 1.0, 1.0, 0.01);
        assert!(sphere_drag_factor(0.1, 10.0, 1.0, 0.01) < slow);
        assert!(sphere_drag_factor(0.2, 1.0, 1.0, 0.01) < slow);
        assert!((0.0..=1.0).contains(&sphere_drag_factor(0.1, 1e9, 1e-6, 1.0)));
    }
    #[test]
    fn pigment_requires_a_finite_physical_impulse_and_mass() {
        assert_eq!(contact_pigment_blend(0.0, 1.0), 0.0);
        assert_eq!(contact_pigment_blend(1.0, 1.0), 0.15);
        assert_eq!(contact_pigment_blend(100.0, 1.0), 0.5);
        for (impulse, mass) in [
            (f32::NAN, 1.0),
            (f32::INFINITY, 1.0),
            (-1.0, 1.0),
            (1.0, 0.0),
            (1.0, -1.0),
            (1.0, f32::NAN),
            (1.0, f32::INFINITY),
        ] {
            assert_eq!(contact_pigment_blend(impulse, mass), 0.0);
        }
    }
    #[test]
    fn contact_light_fills_its_regions_without_erasing_the_swirl() {
        let mut surface = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let mut targets = surface;
        paint_pigment(&mut targets, [0.0, 0.0, 1.0], [0.0, 0.0, 1.0], 0.5);
        assert_eq!(surface, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        assert!(targets[2] > 0.45 && targets[5] > 0.0);
        assert_eq!(&targets[6..9], &[1.0, 0.0, 0.0]);
        advance_pigment(&mut surface, &targets, 1.0 / 120.0);
        assert!(surface[2] > 0.0 && surface[2] < 0.05);
        assert!(pigment_color(&surface)[2] < 0.015);
        surface = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        advance_pigment(&mut surface, &targets, PIGMENT_FILL_SECONDS);
        assert!((surface[2] / targets[2] - 0.63212055).abs() < 1e-6);
        advance_pigment(&mut surface, &targets, 2.0);
        assert!((surface[2] - targets[2]).abs() < 1e-5);
        assert!(
            surface[2] - surface[8] > 0.45,
            "the held swirl collapsed to one color"
        );
    }
    #[test]
    fn pigment_fill_uses_elapsed_time_and_stays_bounded_when_retargeted() {
        let run = |hz| {
            let mut surface = [0.0; 9];
            let mut targets = surface;
            for (color, point) in [
                ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
                ([0.0, 1.0, 0.0], [0.0, 0.0, -1.0]),
                ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
            ] {
                paint_pigment(&mut targets, color, point, 0.5);
                for _ in 0..hz {
                    advance_pigment(&mut surface, &targets, 1.0 / hz as f32);
                    assert!(surface.iter().all(|v| (0.0..=1.0).contains(v)));
                }
            }
            surface
        };
        let expected = run(120);
        for hz in [30, 60, 240] {
            for (a, b) in run(hz).into_iter().zip(expected) {
                assert!((a - b).abs() < 3e-6);
            }
        }
        let mut surface = [0.2; 9];
        assert_eq!(pigment_color(&surface), [0.2; 3]);
        for dt in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            advance_pigment(&mut surface, &[1.0; 9], dt);
            assert_eq!(surface, [0.2; 9]);
        }
        for invalid in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
            advance_pigment(&mut surface, &[invalid; 9], 1.0);
            assert_eq!(surface, [0.2; 9]);
            let mut targets = surface;
            paint_pigment(&mut targets, [invalid; 3], [0.0, 0.0, 1.0], 0.5);
            assert_eq!(targets, surface);
            paint_pigment(&mut targets, [1.0; 3], [0.0, 0.0, 1.0], invalid);
            assert_eq!(targets, surface);
        }
        advance_pigment(&mut surface, &[1.0; 9], f32::MAX);
        assert_eq!(surface, [1.0; 9]);
    }
    #[test]
    fn active_audio_only_adds_color_on_qualified_contact_or_new_attack() {
        assert!(pigment_contact_eligible(false, 0.0, true, false));
        assert!(!pigment_contact_eligible(false, 0.0, false, true));
        assert!(!pigment_contact_eligible(true, 0.0, true, true));
        assert!(pigment_contact_eligible(true, 0.5, true, false));
        assert!(pigment_contact_eligible(true, 0.5, false, true));
        assert!(!pigment_contact_eligible(true, 0.5, false, false));
        for invalid in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
            assert!(!pigment_contact_eligible(true, invalid, true, true));
        }
    }
    #[test]
    fn swirl_weights_are_bounded_and_invalid_contact_points_do_not_paint() {
        for point in [
            [1.0, 0.0, 0.0],
            [-1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ] {
            let weights = pigment_weights(point);
            assert!(weights.iter().all(|v| (0.0..=1.0).contains(v)));
            assert!((weights.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        }
        let mut targets = [0.2; 9];
        paint_pigment(&mut targets, [1.0; 3], [f32::NAN, 0.0, 1.0], 0.5);
        assert_eq!(targets, [0.2; 9]);
    }
}
