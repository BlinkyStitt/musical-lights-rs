//! Allocation-free 250 mm amulet composition, before output response/current caps.
use crate::{
    clock::{PatternClock, PatternTime},
    compass::{Coordinate, Course},
    message::{Position, StateSnapshot},
    navigation::wrap,
    provisioning::SparkleRecord,
};
use num::Float;
use palette::LinSrgb;
pub const COUNTS: [usize; 4] = [256, 64, 84, 90];
pub const PIXELS: usize = 494;
pub const RANGES: [f32; 6] = [100.0, 250.0, 500.0, 1000.0, 2000.0, 5000.0];
pub const PEER_COLORS: [[f32; 3]; 8] = [
    [1.0, 0.15, 0.0],
    [0.0, 0.4, 1.0],
    [0.0, 1.0, 0.3],
    [1.0, 0.0, 0.6],
    [0.7, 0.3, 1.0],
    [1.0, 0.7, 0.0],
    [0.0, 1.0, 1.0],
    [0.7, 0.7, 0.7],
];
fn rgb(c: [f32; 3]) -> LinSrgb {
    LinSrgb::new(c[0], c[1], c[2])
}
fn fract(x: f64) -> f64 {
    x - Float::floor(x)
}
fn tri(x: f64) -> f64 {
    1.0 - (2.0 * fract(x) - 1.0).abs()
}
pub fn rainbow(h: f64) -> LinSrgb {
    let x = fract(h) * 6.0;
    let f = x - Float::floor(x);
    let f = f as f32;
    match x as u8 {
        0 => rgb([1.0, f, 0.0]),
        1 => rgb([1.0 - f, 1.0, 0.0]),
        2 => rgb([0.0, 1.0, f]),
        3 => rgb([0.0, 1.0 - f, 1.0]),
        4 => rgb([f, 0.0, 1.0]),
        _ => rgb([1.0, 0.0, 1.0 - f]),
    }
}
pub fn shared_hue(slot: u8, count: u8, index: usize, length: usize, phase: f64) -> Option<f64> {
    (count > 0 && count <= 8 && slot < count && length > 0 && index < length)
        .then(|| fract((slot as f64 + index as f64 / length as f64) / count as f64 + phase))
}
/// Index along the clockwise mounted path, independent of wire direction.
pub fn path_index(index: usize, settings: &SparkleRecord) -> usize {
    if index < 256 {
        return index;
    }
    let (offset, count, clockwise) = if index < 320 {
        (256, 64, settings.halo_clockwise)
    } else if index < 404 {
        (320, 84, settings.inner_clockwise)
    } else {
        (404, 90, settings.outer_clockwise)
    };
    let seam = settings.rotation.get() as f64 / 100.0 / 360.0 * count as f64;
    let j = index - offset;
    let mounted = seam + if clockwise { j as f64 } else { -(j as f64) };
    offset + (Float::round(mounted) as i32).rem_euclid(count) as usize
}
/// Temporary calibration intent, before the ordinary encoded current caps.
pub fn calibration_frame(
    settings: &SparkleRecord,
    collecting: bool,
    white: bool,
    frame: &mut [LinSrgb; PIXELS],
) {
    if settings.blanked {
        frame.fill(rgb([0.0; 3]));
        return;
    }
    if white {
        frame.fill(rgb([settings.brightness as f32 / 100.0; 3]));
    }
    if collecting {
        for pixel in frame {
            let peak = pixel.red.max(pixel.green).max(pixel.blue);
            if peak > 0.05 {
                *pixel *= 0.05 / peak;
            }
        }
    }
}
fn age(position: Position, elapsed: u64) -> u64 {
    position.age.get() as u64 + elapsed
}
fn coordinate(p: Position) -> Coordinate {
    Coordinate {
        lat: p.lat.get() as i32 as f32 / 1e7,
        lon: p.lon.get() as i32 as f32 / 1e7,
    }
}
fn angle_distance(a: f64, b: f64) -> f64 {
    (wrap(a - b + 180.0) - 180.0).abs()
}
fn group_masks(mut links: [u8; 8]) -> [u8; 8] {
    for _ in 0..8 {
        for i in 0..8 {
            for j in 0..8 {
                if links[i] & (1 << j) != 0 {
                    links[i] |= links[j];
                }
            }
        }
    }
    links
}
fn owns_slot(mask: u8, index: usize, now: u64, duration: u64) -> bool {
    let count = mask.count_ones() as u64;
    if count == 0 {
        return true;
    }
    let rank = (mask & ((1u16 << index) - 1) as u8).count_ones() as u64;
    now / duration % count == rank
}
fn spot(x: f64, y: f64, px: f64, py: f64) -> f32 {
    (1.0 - Float::sqrt((x - px) * (x - px) + (y - py) * (y - py)) / 0.06).clamp(0.0, 1.0) as f32
}
fn arrow(x: f64, y: f64, bearing: f64, outline: bool) -> f32 {
    let a = bearing.to_radians();
    let along = x * Float::sin(a) + y * Float::cos(a);
    let across = x * Float::cos(a) - y * Float::sin(a);
    let shaft = (0.15..=0.70).contains(&along) && across.abs() <= 0.035;
    let head = (0.65..=0.90).contains(&along) && across.abs() <= (0.90 - along) * 0.6;
    if outline {
        f32::from(
            (shaft && across.abs() >= 0.020)
                || (head && (across.abs() >= (0.90 - along) * 0.6 - 0.015)),
        )
    } else {
        f32::from(shaft || head)
    }
}
#[derive(Default)]
pub struct Renderer {
    clock: PatternClock,
    entry: u64,
    previous: Option<(u8, u8)>,
}
impl Renderer {
    pub fn render(
        &mut self,
        settings: &SparkleRecord,
        snapshot: Option<(&StateSnapshot, u64)>,
        now: u64,
        audio: f32,
        microphone_fault: bool,
        frame: &mut [LinSrgb; PIXELS],
    ) -> PatternTime {
        frame.fill(rgb([0.0; 3]));
        let mode = (settings.mode, settings.preset);
        if self.previous != Some(mode) {
            self.entry = now;
            self.previous = Some(mode);
        }
        let utc = snapshot.and_then(|(s, received)| {
            let c = s.clock;
            let elapsed = now.saturating_sub(received) + c.anchor_age.get() as u64;
            if matches!(c.state, 2 | 3)
                && elapsed <= 1800000
                && c.uncertainty.get() as u64 + elapsed.div_ceil(10000) <= 250
            {
                Some((
                    c.utc_anchor.get().saturating_add(elapsed),
                    c.uncertainty
                        .get()
                        .saturating_add(elapsed.div_ceil(10000) as u32),
                ))
            } else {
                None
            }
        });
        let time = self.clock.tick(now, utc);
        if settings.blanked {
            return time;
        }
        let connected = snapshot.is_some_and(|(_, received)| now.saturating_sub(received) <= 2000);
        let (state, received) = snapshot.map_or((None, now), |(s, t)| (Some(s), t));
        let elapsed = now.saturating_sub(received);
        let usable_heading = state.filter(|s| {
            matches!(s.heading.quality, 3 | 4) && s.heading.age.get() as u64 + elapsed <= 200
        });
        let heading = usable_heading
            .filter(|s| s.heading.quality == 4)
            .map(|s| s.heading.true_north.get() as f64 / 100.0);
        let magnetic = usable_heading
            .filter(|s| s.heading.quality == 3)
            .map(|s| s.heading.magnetic.get() as f64 / 100.0);
        let rotation = settings.rotation.get() as f64 / 100.0;
        let reference = if settings.mode == 0 && settings.orientation == 1 {
            0.0
        } else {
            heading.unwrap_or(0.0)
        };
        let local_valid =
            state.is_some_and(|s| s.local.flags.get() & 1 != 0 && age(s.local, elapsed) <= 60000);
        let local_time = (now.saturating_sub(self.entry) as f64 / 1000.0) * 8000.0
            / settings.cycle_ms.get() as f64;
        // Compute navigation once per display frame. Index 0 is north; peers
        // follow their stable, validated ID order. Every ring shares this schedule.
        let mut geometry = [(0.0f64, 0.0f64, false, false, false); 7];
        let mut ring_links = [0u8; 8];
        let mut map_links = [0u8; 8];
        let north_available =
            heading.is_some() || (settings.mode == 0 && settings.orientation == 1);
        if north_available {
            ring_links[0] = 1;
        }
        if let Some(s) = state.filter(|_| local_valid) {
            for (i, peer) in s.peers.iter().enumerate() {
                if peer.position.flags.get() & 1 == 0 || age(peer.position, elapsed) > 60000 {
                    continue;
                }
                let course = Course::spherical_law_of_cosines(
                    coordinate(s.local),
                    coordinate(peer.position),
                    0.0,
                );
                let approximate =
                    peer.position.flags.get() & 4 == 0 || s.local.flags.get() & 4 == 0;
                let uncertainty =
                    (peer.position.accuracy.get() as f64 + s.local.accuracy.get() as f64) / 10.0;
                let uncertain = course.distance == 0.0
                    || (!approximate && course.distance as f64 <= uncertainty);
                geometry[i] = (
                    wrap(course.magnetic_bearing as f64 - reference),
                    (course.distance / RANGES[settings.range as usize]).min(1.0) as f64,
                    approximate,
                    uncertain,
                    course.distance > RANGES[settings.range as usize],
                );
                map_links[i + 1] = 1 << (i + 1);
                if !uncertain && (settings.mode == 0 || heading.is_some()) {
                    ring_links[i + 1] = 1 << (i + 1);
                }
            }
            for i in 0..=s.peers.len() {
                for j in 0..i {
                    if ring_links[i] != 0 && ring_links[j] != 0 {
                        let bearing = |n: usize| {
                            if n == 0 {
                                wrap(-reference)
                            } else {
                                geometry[n - 1].0
                            }
                        };
                        let width = |n: usize| {
                            if n == 0 {
                                3.0
                            } else if settings.selected == Some(s.peers[n - 1].id) {
                                11.0
                            } else if geometry[n - 1].2 {
                                7.0
                            } else {
                                2.0
                            }
                        };
                        if angle_distance(bearing(i), bearing(j)) <= width(i) + width(j) {
                            ring_links[i] |= 1 << j;
                            ring_links[j] |= 1 << i;
                        }
                    }
                    if j > 0 && map_links[i] != 0 && map_links[j] != 0 {
                        let point = |n: usize| {
                            let (b, r, _, uncertain, _) = geometry[n - 1];
                            let r = if uncertain { 0.08 } else { r };
                            (
                                r * Float::sin(b.to_radians()),
                                r * Float::cos(b.to_radians()),
                            )
                        };
                        let (x, y) = point(i);
                        let (px, py) = point(j);
                        if Float::sqrt((x - px) * (x - px) + (y - py) * (y - py)) < 0.12 {
                            map_links[i] |= 1 << j;
                            map_links[j] |= 1 << i;
                        }
                    }
                }
            }
        }
        let ring_groups = group_masks(ring_links);
        let map_groups = group_masks(map_links);
        for (index, pixel) in frame.iter_mut().enumerate() {
            let (x, y, ring, ring_count, a) = if index < 256 {
                let x = (crate::lights::fibonacci_layout::COORDS_X[index] as f64 - 127.5) / 127.5;
                let y = (127.5 - crate::lights::fibonacci_layout::COORDS_Y[index] as f64) / 127.5;
                let a = wrap(Float::atan2(x, y).to_degrees() + rotation);
                let r = Float::sqrt(x * x + y * y);
                (
                    r * Float::sin(a.to_radians()),
                    r * Float::cos(a.to_radians()),
                    false,
                    0,
                    a,
                )
            } else {
                let (offset, count, clockwise) = if index < 320 {
                    (256, 64, settings.halo_clockwise)
                } else if index < 404 {
                    (320, 84, settings.inner_clockwise)
                } else {
                    (404, 90, settings.outer_clockwise)
                };
                let a = wrap(
                    rotation
                        + (index - offset) as f64 / count as f64
                            * 360.0
                            * if clockwise { 1.0 } else { -1.0 },
                );
                (
                    Float::sin(a.to_radians()),
                    Float::cos(a.to_radians()),
                    true,
                    count,
                    a,
                )
            };
            let r = Float::sqrt(x * x + y * y).min(1.0);
            let angle = a / 360.0;
            let mut color = rgb([0.0; 3]);
            if !connected {
                if ring && now % 1000 < 200 && (a % 90.0).min(90.0 - a % 90.0) <= 4.0 {
                    color = rgb([1.0, 0.35, 0.0]) * 0.2;
                }
            } else if settings.mode == 0 && !local_valid {
                let orbit = (now % 2000) as f64 / 2000.0 * core::f64::consts::TAU;
                if !ring {
                    color = rgb([1.0, 0.35, 0.0])
                        * spot(x, y, 0.5 * Float::sin(orbit), 0.5 * Float::cos(orbit));
                }
            } else if settings.mode == 2 {
                color = match settings.preset {
                    0 => rainbow(angle + 2.0 * r - local_time / 8.0),
                    1 => {
                        rainbow(angle - local_time / 8.0)
                            * Float::powi(
                                Float::cos(
                                    core::f64::consts::TAU * (3.0 * angle - 3.0 * local_time / 8.0),
                                )
                                .max(0.0),
                                8,
                            ) as f32
                    }
                    2 => {
                        rainbow(r - local_time / 8.0)
                            * (0.1 + 0.9 * tri(2.0 * r - local_time / 4.0)) as f32
                    }
                    3 => state
                        .and_then(|s| {
                            shared_hue(
                                s.slot,
                                s.count,
                                path_index(index, settings),
                                PIXELS,
                                time.seconds / (settings.cycle_ms.get() as f64 / 1000.0),
                            )
                        })
                        .map_or(rgb([0.0; 3]), |h| rainbow(h) * time.intensity),
                    4 => {
                        rainbow(angle - local_time / 8.0)
                            * audio.clamp(0.0, 1.0)
                            * if ring {
                                1.0
                            } else {
                                (1.0 - (r - audio as f64).abs() / 0.15).max(0.0) as f32
                            }
                    }
                    _ => rgb([0.0; 3]),
                };
                if settings.preset == 3
                    && !time.synchronized
                    && now % 2000 < 100
                    && ring
                    && angle_distance(a, 12.0).min(angle_distance(a, 348.0)) < 3.0
                {
                    color = rgb([1.0, 0.35, 0.0]) * 0.2;
                }
            } else if let Some(s) = state {
                if !ring && r < 0.04 {
                    color = rgb([1.0; 3]);
                }
                // Map bearings come from true coordinates; heading only rotates the view.
                let north = wrap(-reference);
                if ring
                    && north_available
                    && owns_slot(ring_groups[0], 0, now, 300)
                    && angle_distance(a, north) <= (180.0 / ring_count as f64).max(3.0)
                {
                    color = rgb([1.0; 3]) * 0.35;
                }
                if settings.mode == 1 && settings.selected.is_none() && heading.is_some() && !ring {
                    color = rgb([1.0; 3]) * (0.35 * arrow(x, y, north, false));
                }
                if settings.mode == 1
                    && now % 1000 < 200
                    && let Some(magnetic) = magnetic
                {
                    let north = wrap(-magnetic);
                    if ring && angle_distance(a, north) <= (180.0 / ring_count as f64).max(3.0) {
                        color = rgb([1.0, 0.35, 0.0]) * 0.2;
                    }
                    if !ring && settings.selected.is_none() {
                        color = rgb([1.0, 0.35, 0.0]) * (0.2 * arrow(x, y, north, false));
                    }
                }
                for (peer_index, peer) in s.peers.iter().enumerate() {
                    if !local_valid || (settings.mode == 1 && heading.is_none()) {
                        continue;
                    }
                    let peer_age = age(peer.position, elapsed);
                    if peer.position.flags.get() & 1 == 0 || peer_age > 60000 {
                        continue;
                    }
                    let stale = peer_age > 15000
                        || age(s.local, elapsed) > 15000
                        || !peer.freshness_verified;
                    if stale && now % 1000 >= 200 {
                        continue;
                    }
                    let selected = settings.selected == Some(peer.id);
                    let (bearing, radius, approximate, uncertain, out) = geometry[peer_index];
                    let mut intensity = 0.0;
                    if ring && !uncertain && (settings.mode == 0 || heading.is_some()) {
                        let width = if selected { 5.0 } else { 2.0 };
                        let resolution = 180.0 / ring_count as f64;
                        let main = if approximate {
                            angle_distance(a, bearing - 5.0).min(angle_distance(a, bearing + 5.0))
                                <= 2.0_f64.max(resolution)
                        } else {
                            angle_distance(a, bearing) <= width.max(resolution)
                        };
                        if main {
                            intensity = 0.5;
                        }
                        if selected
                            && now % 1200 < 150
                            && angle_distance(a, bearing - 9.0)
                                .min(angle_distance(a, bearing + 9.0))
                                <= resolution
                        {
                            intensity = 0.5;
                        }
                        if !owns_slot(ring_groups[peer_index + 1], peer_index + 1, now, 300) {
                            intensity = 0.0;
                        }
                    } else if !ring && settings.mode == 0 {
                        let b = bearing.to_radians();
                        if uncertain {
                            if owns_slot(map_groups[peer_index + 1], peer_index + 1, now, 600) {
                                intensity =
                                    0.5 * spot(x, y, 0.08 * Float::sin(b), 0.08 * Float::cos(b));
                            }
                        } else {
                            let distance = |b: f64, r: f64| {
                                Float::sqrt(
                                    (x - r * Float::sin(b)) * (x - r * Float::sin(b))
                                        + (y - r * Float::cos(b)) * (y - r * Float::cos(b)),
                                )
                            };
                            let glyph = |b: f64, r: f64| {
                                if approximate {
                                    (1.0 - (distance(b, r) - 0.06).abs() / 0.015).clamp(0.0, 1.0)
                                        as f32
                                } else {
                                    spot(x, y, r * Float::sin(b), r * Float::cos(b))
                                }
                            };
                            intensity = if owns_slot(
                                map_groups[peer_index + 1],
                                peer_index + 1,
                                now,
                                600,
                            ) {
                                0.5 * if out {
                                    glyph(b - 4.0_f64.to_radians(), 0.95)
                                        .max(glyph(b + 4.0_f64.to_radians(), 0.95))
                                } else {
                                    glyph(b, radius)
                                }
                            } else {
                                0.0
                            };
                        }
                    } else if !ring
                        && settings.mode == 1
                        && selected
                        && !stale
                        && !uncertain
                        && heading.is_some()
                    {
                        intensity = 0.5 * arrow(x, y, bearing, approximate);
                    }
                    if intensity > 0.0 {
                        color = rgb(PEER_COLORS[peer.color as usize])
                            * (intensity * if stale { 0.3 } else { 1.0 });
                    }
                }
            }
            if connected
                && ring
                && let Some(s) = state
            {
                let active = [
                    matches!(s.battery.state, 0 | 3 | 4),
                    settings.mode != 2 && usable_heading.is_none(),
                    s.health.get() & crate::radio::RADIO_FAULT != 0,
                    microphone_fault,
                ];
                let count = active.iter().filter(|enabled| **enabled).count();
                let cue = if count > 0 {
                    active
                        .iter()
                        .enumerate()
                        .filter(|(_, enabled)| **enabled)
                        .nth((now / 2000) as usize % count)
                        .map(|(i, _)| i)
                } else {
                    None
                };
                let phase = now % 2000;
                if phase < 600 {
                    let power = match s.battery.state {
                        0 => phase < 100 || (200..300).contains(&phase),
                        3 => now % 4000 < 200,
                        4 => now % 1000 < 200,
                        _ => false,
                    };
                    let heading = phase < 150 || (300..450).contains(&phase);
                    let width = (180.0 / ring_count as f64).max(3.0);
                    if cue == Some(0) && power && angle_distance(a, 180.0) <= 8.0
                        || cue == Some(1)
                            && heading
                            && angle_distance(a, 12.0).min(angle_distance(a, 348.0)) <= width
                    {
                        color = rgb([1.0, 0.35, 0.0]) * 0.2;
                    }
                    if matches!(cue, Some(2 | 3))
                        && phase < 200
                        && angle_distance(a, 90.0).min(angle_distance(a, 270.0)) <= width
                    {
                        color = rgb([1.0, 0.0, 1.0]) * 0.2;
                    }
                }
            }
            *pixel = color
                * (settings.brightness as f32 / 100.0)
                * state.map_or(1.0, |s| s.battery.factor.get() as f32 / 1000.0);
        }
        time
    }
}
