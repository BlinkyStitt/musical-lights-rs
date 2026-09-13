//! Decorative browser physics. Coordinates span the balloon layer, with y up.
//! The simulation has no browser dependencies; only the animation owns the DOM.
mod animation;
pub use animation::BalloonAnimation;

use musical_lights_core::{
    audio::visual::{DISPLAY_BANDS, DisplayFrame},
    lights::{Gradient, screen_color},
};

pub const BALLOON_COUNT: usize = 24;
/// Circular top corners use one quarter of the bar width in CSS and physics.
pub const BAR_CORNER_RATIO: f64 = 0.25;
const MAX_DT: f64 = 1.0 / 30.0;
// Graph heights per second squared. Gravity always uses page coordinates;
// device orientation supplies only the much smaller wind contribution.
const GRAVITY: f64 = 4.8;
const REDUCED_GRAVITY: f64 = 2.4;
const MAX_SPEED: f64 = 3.2;
const REST_SPEED: f64 = 0.2;
const CONTACT_SLOP: f64 = 0.0005;
// Contacts share displacement with shape compression. Shape recovers over
// time, so sustained pressure can flatten a body without a reserved empty area.
const SHAPE_MOBILITY: f64 = 0.15;
// Numerical floor only. A visible minimum width can exceed a bar gap and
// leave the contact constraints with no valid shape inside that gap.
const MIN_SHAPE: f64 = 1e-6;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Vector {
    x: f64,
    y: f64,
}

impl Vector {
    fn bounded(self, limit: f64) -> Self {
        let length = self.x.hypot(self.y);
        let scale = if length > limit { limit / length } else { 1.0 };
        Self {
            x: self.x * scale,
            y: self.y * scale,
        }
    }

    fn screen(self, angle: f64) -> Self {
        let (sin, cos) = finite(angle).to_radians().sin_cos();
        Self {
            x: self.x * cos - self.y * sin,
            y: self.x * sin + self.y * cos,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Balloon {
    pub width_in_bars: f64,
    position: Vector,
    velocity: Vector,
    deformation: Vector,
    /// Persistent, unencoded linear-sRGB channels. Never sample nearby colors.
    color: [f32; 3],
    contacts: [bool; DISPLAY_BANDS],
}

impl Balloon {
    pub fn style(&self) -> String {
        format!(
            "--balloon-bars: {}; --balloon-x: {}%; --balloon-y: {}%; --balloon-color: {}; --balloon-scale-x: {}; --balloon-scale-y: {};",
            self.width_in_bars,
            self.position.x * 100.0,
            (1.0 - self.position.y) * 100.0,
            self.css_color(),
            self.deformation.x,
            self.deformation.y,
        )
    }

    fn css_color(&self) -> String {
        let color = screen_color(self.color.into());
        format!("color(srgb {} {} {})", color.red, color.green, color.blue)
    }

    fn impact_color(&mut self, color: [f32; 3], impulse: f64) {
        let blend = (impulse * 0.8).clamp(0.0, 0.5) as f32;
        for (current, target) in self.color.iter_mut().zip(color) {
            *current += (target - *current) * blend;
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Bar {
    left: f64,
    right: f64,
}

/// Actual meter bounds, normalized to the layer. Bodies are round at rest and
/// become capsules under pressure, using the same dimensions as CSS.
#[derive(Clone, Copy, Debug)]
struct Geometry {
    bars: [Bar; DISPLAY_BANDS],
    bar_height: f64,
    aspect: f64,
    baseline: f64,
}

impl Geometry {
    fn rest_radii(self, balloon: &Balloon) -> Vector {
        let x = balloon.width_in_bars * (self.bars[0].right - self.bars[0].left) * 0.5;
        Vector {
            x,
            y: x * self.aspect,
        }
    }

    fn radii(self, balloon: &Balloon) -> Vector {
        let rest = self.rest_radii(balloon);
        Vector {
            x: rest.x * balloon.deformation.x,
            y: rest.y * balloon.deformation.y,
        }
    }
}

#[derive(Clone)]
pub struct BalloonWorld {
    pub balloons: [Balloon; BALLOON_COUNT],
    palette: [[f32; 3]; DISPLAY_BANDS],
    previous_levels: [f64; DISPLAY_BANDS],
    pointer: Option<Vector>,
    wind: Vector,
    target_wind: Vector,
    shake: Vector,
    shake_cooldown: f64,
    reduced: bool,
}

impl BalloonWorld {
    pub fn new(palette: Gradient<DISPLAY_BANDS>) -> Self {
        let palette = palette.colors.map(|c| [c.red, c.green, c.blue]);
        let widths = [
            0.55, 1.4, 2.2, 0.8, 3.1, 1.0, 4.0, 1.8, 0.65, 2.6, 1.2, 3.5, 0.65, 1.0, 1.2, 0.8, 1.4,
            0.55, 0.7, 1.1, 1.6, 0.9, 1.3, 0.6,
        ];
        Self {
            balloons: std::array::from_fn(|i| {
                let row = i / 6;
                let position = Vector {
                    x: [0.08, 0.09, 0.14, 0.155][row]
                        + (i % 6) as f64 * [0.16, 0.16, 0.145, 0.145][row],
                    y: [0.52, 0.72, 0.14, 0.29][row] + (i % 3) as f64 * 0.025,
                };
                Balloon {
                    width_in_bars: widths[i],
                    position,
                    velocity: Vector::default(),
                    deformation: Vector { x: 1.0, y: 1.0 },
                    color: palette[(position.x * DISPLAY_BANDS as f64) as usize],
                    contacts: [false; DISPLAY_BANDS],
                }
            }),
            palette,
            previous_levels: [0.0; DISPLAY_BANDS],
            pointer: None,
            wind: Vector::default(),
            target_wind: Vector::default(),
            shake: Vector::default(),
            shake_cooldown: 0.0,
            reduced: false,
        }
    }

    fn tilt(&mut self, beta: f64, gamma: f64, angle: f64) {
        self.target_wind = Vector {
            x: finite(gamma).clamp(-45.0, 45.0) / 45.0 * 0.12,
            y: -finite(beta).clamp(-45.0, 45.0) / 45.0 * 0.12,
        }
        .screen(angle)
        .bounded(0.12);
    }

    fn shake(&mut self, x: f64, y: f64, angle: f64) {
        if self.reduced || self.shake_cooldown > 0.0 {
            return;
        }
        let acceleration = Vector {
            x: finite(x),
            y: finite(y),
        };
        if acceleration.x.hypot(acceleration.y) < 3.0 {
            return;
        }
        self.shake = Vector {
            x: -acceleration.x * 0.018,
            y: -acceleration.y * 0.018,
        }
        .screen(angle)
        .bounded(0.3);
        self.shake_cooldown = 0.18;
    }

    fn clear_motion(&mut self) {
        self.wind = Vector::default();
        self.target_wind = Vector::default();
        self.shake = Vector::default();
        self.shake_cooldown = 0.0;
        self.previous_levels.fill(0.0);
        for balloon in &mut self.balloons {
            balloon.contacts.fill(false);
        }
    }

    fn step(&mut self, dt: f64, frame: DisplayFrame<DISPLAY_BANDS>, geometry: Geometry) {
        let dt = finite(dt).clamp(0.0, MAX_DT);
        if dt == 0.0 {
            return;
        }
        if geometry.rest_radii(&self.balloons[0]).y <= 0.0 {
            return;
        }
        let levels = frame
            .levels
            .map(|level| finite(level as f64).clamp(0.0, 1.0) * geometry.bar_height);
        let previous = self.previous_levels;
        let rise = levels
            .iter()
            .zip(previous)
            .map(|(level, previous)| (level - previous).max(0.0))
            .fold(0.0, f64::max);
        // Limit travel on each axis to half that body's extent. A thin vertical
        // capsule does not need tiny vertical steps because its width is small.
        // Keep bar rise in the vertical bound so attacks cannot cross a body.
        let steps = self
            .balloons
            .iter()
            .map(|balloon| {
                let radius = geometry.radii(balloon);
                let x = ((balloon.velocity.x + self.shake.x).abs() + 2.0 * dt) * dt;
                let y =
                    ((balloon.velocity.y + self.shake.y).abs() + (GRAVITY + 2.0) * dt) * dt + rise;
                (x / (radius.x * 0.5)).max(y / (radius.y * 0.5))
            })
            .fold(1.0, f64::max)
            .ceil() as usize;
        for step in 1..=steps {
            let progress = step as f64 / steps as f64;
            let levels = std::array::from_fn(|band| {
                previous[band] + (levels[band] - previous[band]) * progress
            });
            self.advance(dt / steps as f64, levels, geometry);
        }
    }

    fn advance(&mut self, dt: f64, levels: [f64; DISPLAY_BANDS], geometry: Geometry) {
        self.shake_cooldown = (self.shake_cooldown - dt).max(0.0);
        let wind_mix = 1.0 - (-dt * 1.5).exp();
        self.wind.x += (self.target_wind.x - self.wind.x) * wind_mix;
        self.wind.y += (self.target_wind.y - self.wind.y) * wind_mix;
        let motion_scale = if self.reduced { 0.2 } else { 1.0 };
        let drag = if self.reduced { 9.0 } else { 0.6 };
        let restitution = if self.reduced { 0.15 } else { 0.7 };
        for (index, balloon) in self.balloons.iter_mut().enumerate() {
            let shape = balloon.deformation;
            let recovery = 1.0 - (-dt * if self.reduced { 6.0 } else { 10.0 }).exp();
            // A compressed axis gently expands the other axis, pushing nearby
            // bodies. Contact constraints also act on this recovered shape.
            balloon.deformation.x += (1.0 + 0.25 * (1.0 - shape.y).max(0.0) - shape.x) * recovery;
            balloon.deformation.y += (1.0 + 0.25 * (1.0 - shape.x).max(0.0) - shape.y) * recovery;
            let radius = geometry.radii(balloon);
            let before = balloon.position;
            let mut force = Vector {
                x: self.wind.x,
                y: self.wind.y,
            };
            if !self.reduced {
                balloon.velocity.x += self.shake.x;
                balloon.velocity.y += self.shake.y;
            }
            if let Some(pointer) = self.pointer {
                let dx = (balloon.position.x - pointer.x) * geometry.aspect;
                let dy = balloon.position.y - pointer.y;
                let distance = dx.hypot(dy);
                let reach = 0.2 + radius.y;
                if distance < reach {
                    let strength = (1.0 - distance / reach).powi(2) * 1.8;
                    // At the exact center, use a deterministic sideways escape.
                    let direction = if distance > 1e-6 {
                        Vector {
                            x: dx / distance / geometry.aspect,
                            y: dy / distance,
                        }
                    } else {
                        Vector {
                            x: if index % 2 == 0 { 1.0 } else { -1.0 },
                            y: 0.0,
                        }
                    };
                    force.x += direction.x * strength;
                    force.y += direction.y * strength;
                }
            }
            integrate_axis(
                &mut balloon.position.x,
                &mut balloon.velocity.x,
                force.x * motion_scale,
                drag,
                dt,
            );
            integrate_axis(
                &mut balloon.position.y,
                &mut balloon.velocity.y,
                force.y * motion_scale
                    - if self.reduced {
                        REDUCED_GRAVITY
                    } else {
                        GRAVITY
                    },
                drag,
                dt,
            );
            balloon.velocity = balloon.velocity.bounded(MAX_SPEED);
            let incoming = balloon.velocity;
            let candidate = balloon.position;
            let mut contacts = [false; DISPLAY_BANDS];
            // Evaluate all hits from the same candidate position, then resolve
            // and blend in ascending bar order, even for a wide balloon.
            for (band, bar) in geometry.bars.iter().enumerate() {
                let top = levels[band];
                let slop = if balloon.contacts[band] {
                    CONTACT_SLOP
                } else {
                    0.0
                };
                let from_above = before.y - radius.y >= self.previous_levels[band] - CONTACT_SLOP;
                let Some(hit) =
                    bar_contact(candidate, radius, *bar, top, geometry, from_above, slop)
                else {
                    continue;
                };
                contacts[band] = true;
                let normal = hit.normal;
                // Resolve from the current position so simultaneous surfaces do
                // not apply the same penetration correction more than once.
                if let Some(correction) = bar_contact(
                    balloon.position,
                    geometry.radii(balloon),
                    *bar,
                    top,
                    geometry,
                    from_above,
                    0.0,
                ) {
                    resolve_bar(balloon, correction, geometry);
                }
                let rise = top - self.previous_levels[band];
                let approach =
                    (-(incoming.x * geometry.aspect * normal.x + incoming.y * normal.y)).max(0.0);
                if !balloon.contacts[band] && (rise > 1e-6 || approach > REST_SPEED) {
                    let rebound = if approach > REST_SPEED {
                        approach * restitution
                    } else {
                        0.0
                    };
                    let outgoing = ((rise / dt * normal.y * 0.1).clamp(0.0, 0.7) * motion_scale
                        + rebound)
                        .min(MAX_SPEED);
                    let current = balloon.velocity.x * geometry.aspect * normal.x
                        + balloon.velocity.y * normal.y;
                    let change = (outgoing - current).max(0.0);
                    balloon.velocity.x += normal.x * change / geometry.aspect;
                    balloon.velocity.y += normal.y * change;
                    // A resting contact has no impact. A falling sphere can
                    // bounce off a stationary bar without gaining energy.
                    let impulse = approach + outgoing;
                    balloon.impact_color(self.palette[band], impulse);
                }
            }
            balloon.contacts = contacts;
            balloon.velocity = balloon.velocity.bounded(MAX_SPEED);
            constrain(balloon, geometry, levels, restitution);
        }
        self.resolve_contacts(geometry, levels, restitution);
        self.shake = Vector::default();
        self.previous_levels = levels;
    }

    fn resolve_contacts(
        &mut self,
        geometry: Geometry,
        levels: [f64; DISPLAY_BANDS],
        restitution: f64,
    ) {
        // Revisit contacts in a stable order to resolve piles against bars and
        // walls. Position corrections add neither velocity nor color.
        for _ in 0..64 {
            let mut overlap: f64 = 0.0;
            for i in 0..BALLOON_COUNT {
                let (left, right) = self.balloons.split_at_mut(i + 1);
                for other in right {
                    overlap = overlap.max(collide(&mut left[i], other, geometry, restitution));
                }
            }
            for balloon in &mut self.balloons {
                overlap = overlap.max(constrain(balloon, geometry, levels, restitution));
                balloon.velocity = balloon.velocity.bounded(MAX_SPEED);
            }
            if overlap < 1e-7 {
                break;
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct BarContact {
    /// Unit normal in graph-height coordinates, where circles stay circular.
    normal: Vector,
    depth: f64,
}

/// A capsule is a line segment swept by a circle. CSS uses the same shape:
/// independent width/height and a corner radius of half the shorter dimension.
fn capsule(radius: Vector, aspect: f64) -> (Vector, f64) {
    let x = radius.x * aspect;
    let round = x.min(radius.y);
    (
        Vector {
            x: x - round,
            y: radius.y - round,
        },
        round,
    )
}

/// Offset the bar's inner rectangle by the capsule's line segment and the
/// combined corner radii. This retains exact circular corner normals.
fn bar_contact(
    position: Vector,
    radius: Vector,
    bar: Bar,
    top: f64,
    geometry: Geometry,
    from_above: bool,
    slop: f64,
) -> Option<BarContact> {
    if top <= 0.0 {
        return None;
    }
    let left = bar.left * geometry.aspect;
    let right = bar.right * geometry.aspect;
    let corner = ((right - left) * BAR_CORNER_RATIO).min(top + geometry.baseline);
    let (segment, round) = capsule(radius, geometry.aspect);
    let x = position.x * geometry.aspect;
    let delta = Vector {
        x: x - x.clamp(left + corner - segment.x, right - corner + segment.x),
        y: position.y - position.y.min(top - corner + segment.y),
    };
    let distance = delta.x.hypot(delta.y);
    if distance > 1e-12 {
        let depth = corner + round - distance;
        return (depth >= -slop).then_some(BarContact {
            normal: Vector {
                x: delta.x / distance,
                y: delta.y / distance,
            },
            depth: depth.max(0.0),
        });
    }
    // A rising bar can enclose a center. Keep a ball that was above the bar
    // on its top; otherwise select the nearest side or top to leave the solid.
    let up = top + radius.y - position.y;
    let to_left = x - left + radius.x * geometry.aspect;
    let to_right = right - x + radius.x * geometry.aspect;
    Some(if from_above || up <= to_left.min(to_right) {
        BarContact {
            normal: Vector { x: 0.0, y: 1.0 },
            depth: up,
        }
    } else if to_left <= to_right {
        BarContact {
            normal: Vector { x: -1.0, y: 0.0 },
            depth: to_left,
        }
    } else {
        BarContact {
            normal: Vector { x: 1.0, y: 0.0 },
            depth: to_right,
        }
    })
}

// Derivatives of a capsule's support distance with respect to its two extents.
fn shape_gradient(balloon: &Balloon, normal: Vector, geometry: Geometry) -> Vector {
    let radius = geometry.radii(balloon);
    let mut gradient = if radius.x * geometry.aspect >= radius.y {
        Vector {
            x: normal.x.abs(),
            y: 1.0 - normal.x.abs(),
        }
    } else {
        Vector {
            x: 1.0 - normal.y.abs(),
            y: normal.y.abs(),
        }
    };
    if balloon.deformation.x <= MIN_SHAPE {
        gradient.x = 0.0;
    }
    if balloon.deformation.y <= MIN_SHAPE {
        gradient.y = 0.0;
    }
    gradient
}

fn compress(balloon: &mut Balloon, gradient: Vector, amount: f64, geometry: Geometry) {
    let rest = geometry.rest_radii(balloon).y;
    balloon.deformation.x = (balloon.deformation.x - gradient.x * amount / rest).max(MIN_SHAPE);
    balloon.deformation.y = (balloon.deformation.y - gradient.y * amount / rest).max(MIN_SHAPE);
}

fn shape_response(balloon: &Balloon, gradient: Vector) -> Vector {
    // Compression increases stiffness. A crowded body can flatten, but a thin
    // axis must resist further collapse instead of becoming easier to crush.
    Vector {
        x: gradient.x * SHAPE_MOBILITY * balloon.deformation.x,
        y: gradient.y * SHAPE_MOBILITY * balloon.deformation.y,
    }
}

fn project_surface(balloon: &mut Balloon, hit: BarContact, geometry: Geometry) {
    let gradient = shape_gradient(balloon, hit.normal, geometry);
    let shape = shape_response(balloon, gradient);
    let response = hit.depth / (1.0 + gradient.x * shape.x + gradient.y * shape.y);
    balloon.position.x += hit.normal.x * response / geometry.aspect;
    balloon.position.y += hit.normal.y * response;
    compress(balloon, shape, response, geometry);
}

fn resolve_bar(balloon: &mut Balloon, hit: BarContact, geometry: Geometry) {
    project_surface(balloon, hit, geometry);
    let inward =
        balloon.velocity.x * geometry.aspect * hit.normal.x + balloon.velocity.y * hit.normal.y;
    if inward < 0.0 {
        balloon.velocity.x -= hit.normal.x * inward / geometry.aspect;
        balloon.velocity.y -= hit.normal.y * inward;
    }
}

/// Exact separation of two axis-aligned capsules through their Minkowski sum.
fn body_contact(a: &Balloon, b: &Balloon, geometry: Geometry) -> Option<BarContact> {
    let ra = geometry.radii(a);
    let rb = geometry.radii(b);
    let delta = Vector {
        x: (b.position.x - a.position.x) * geometry.aspect,
        y: b.position.y - a.position.y,
    };
    if delta.x.abs() > (ra.x + rb.x) * geometry.aspect || delta.y.abs() > ra.y + rb.y {
        return None;
    }
    let (sa, ca) = capsule(ra, geometry.aspect);
    let (sb, cb) = capsule(rb, geometry.aspect);
    let core = Vector {
        x: sa.x + sb.x,
        y: sa.y + sb.y,
    };
    let offset = Vector {
        x: delta.x - delta.x.clamp(-core.x, core.x),
        y: delta.y - delta.y.clamp(-core.y, core.y),
    };
    let distance = offset.x.hypot(offset.y);
    let round = ca + cb;
    if distance > 1e-12 {
        return (distance <= round).then_some(BarContact {
            normal: Vector {
                x: offset.x / distance,
                y: offset.y / distance,
            },
            depth: round - distance,
        });
    }
    let x = core.x + round - delta.x.abs();
    let y = core.y + round - delta.y.abs();
    Some(if x <= y {
        BarContact {
            normal: Vector {
                x: if delta.x < 0.0 { -1.0 } else { 1.0 },
                y: 0.0,
            },
            depth: x,
        }
    } else {
        BarContact {
            normal: Vector {
                x: 0.0,
                y: if delta.y < 0.0 { -1.0 } else { 1.0 },
            },
            depth: y,
        }
    })
}

/// Mass follows the resting circle area, even while the body compresses.
/// Contact impulses conserve momentum and lose energy.
/// Only bar impacts own color changes, so this operation never touches color.
fn collide(a: &mut Balloon, b: &mut Balloon, geometry: Geometry, restitution: f64) -> f64 {
    let Some(hit) = body_contact(a, b, geometry) else {
        return 0.0;
    };
    let normal = hit.normal;
    let ra = geometry.rest_radii(a).y;
    let rb = geometry.rest_radii(b).y;
    let inverse_a = 1.0 / (ra * ra);
    let inverse_b = 1.0 / (rb * rb);
    let share_a = inverse_a / (inverse_a + inverse_b);
    let share_b = 1.0 - share_a;
    let ga = shape_gradient(a, normal, geometry);
    let gb = shape_gradient(b, normal, geometry);
    let sa = shape_response(a, ga);
    let sb = shape_response(b, gb);
    let response = hit.depth
        / (inverse_a
            + inverse_b
            + inverse_a * (ga.x * sa.x + ga.y * sa.y)
            + inverse_b * (gb.x * sb.x + gb.y * sb.y));
    a.position.x -= normal.x * response * inverse_a / geometry.aspect;
    a.position.y -= normal.y * response * inverse_a;
    b.position.x += normal.x * response * inverse_b / geometry.aspect;
    b.position.y += normal.y * response * inverse_b;
    compress(a, sa, response * inverse_a, geometry);
    compress(b, sb, response * inverse_b, geometry);
    let relative = (b.velocity.x - a.velocity.x) * geometry.aspect * normal.x
        + (b.velocity.y - a.velocity.y) * normal.y;
    if relative < 0.0 {
        let bounce = if -relative > REST_SPEED {
            restitution
        } else {
            0.0
        };
        let impulse = -(1.0 + bounce) * relative;
        a.velocity.x -= normal.x * impulse * share_a / geometry.aspect;
        a.velocity.y -= normal.y * impulse * share_a;
        b.velocity.x += normal.x * impulse * share_b / geometry.aspect;
        b.velocity.y += normal.y * impulse * share_b;
    }
    hit.depth
}

fn constrain(
    balloon: &mut Balloon,
    geometry: Geometry,
    levels: [f64; DISPLAY_BANDS],
    restitution: f64,
) -> f64 {
    let mut overlap = constrain_walls(balloon, geometry, restitution);
    // A collision correction can place a body over another surface. Restore
    // support without counting the correction as another bar impact.
    for (band, bar) in geometry.bars.iter().enumerate() {
        if let Some(hit) = bar_contact(
            balloon.position,
            geometry.radii(balloon),
            *bar,
            levels[band],
            geometry,
            true,
            0.0,
        ) {
            overlap = overlap.max(hit.depth);
            resolve_bar(balloon, hit, geometry);
        }
    }
    overlap.max(constrain_walls(balloon, geometry, restitution))
}

fn constrain_walls(balloon: &mut Balloon, geometry: Geometry, restitution: f64) -> f64 {
    let mut overlap: f64 = 0.0;
    for (normal, boundary) in [
        (Vector { x: 1.0, y: 0.0 }, 0.0),
        (Vector { x: -1.0, y: 0.0 }, -geometry.aspect),
        (Vector { x: 0.0, y: 1.0 }, 0.0),
        (Vector { x: 0.0, y: -1.0 }, -1.0),
    ] {
        let radius = geometry.radii(balloon);
        let support = radius.x * geometry.aspect * normal.x.abs() + radius.y * normal.y.abs();
        let position =
            balloon.position.x * geometry.aspect * normal.x + balloon.position.y * normal.y;
        let depth = boundary + support - position;
        if depth <= 0.0 {
            continue;
        }
        overlap = overlap.max(depth);
        project_surface(balloon, BarContact { normal, depth }, geometry);
        let incoming =
            balloon.velocity.x * geometry.aspect * normal.x + balloon.velocity.y * normal.y;
        if incoming < 0.0 {
            let bounce = if -incoming > REST_SPEED {
                restitution
            } else {
                0.0
            };
            balloon.velocity.x -= normal.x * incoming * (1.0 + bounce) / geometry.aspect;
            balloon.velocity.y -= normal.y * incoming * (1.0 + bounce);
        }
    }
    overlap
}

fn finite(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

/// Exact constant-acceleration/linear-drag integration makes free fall agree
/// across refresh rates without the old slow oscillating float.
fn integrate_axis(position: &mut f64, velocity: &mut f64, force: f64, drag: f64, dt: f64) {
    let response = -(-drag * dt).exp_m1() / drag;
    *position += *velocity * response + force * (dt - response) / drag;
    *velocity += (force - drag * *velocity) * response;
}

#[cfg(test)]
mod tests;
