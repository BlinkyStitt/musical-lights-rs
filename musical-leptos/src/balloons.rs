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
    /// Persistent, unencoded linear-sRGB channels. Never sample nearby colors.
    color: [f32; 3],
    contacts: [bool; DISPLAY_BANDS],
}

impl Balloon {
    pub fn style(&self) -> String {
        format!(
            "--balloon-bars: {}; left: {}%; top: {}%; --balloon-color: {};",
            self.width_in_bars,
            self.position.x * 100.0,
            (1.0 - self.position.y) * 100.0,
            self.css_color()
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

/// Actual meter bounds, normalized to the layer. Headroom leaves space above
/// a full-height bar. Width/height keeps each body circular in screen pixels.
#[derive(Clone, Copy, Debug)]
struct Geometry {
    bars: [Bar; DISPLAY_BANDS],
    bar_height: f64,
    aspect: f64,
    baseline: f64,
}

impl Geometry {
    fn radii(self, balloon: &Balloon) -> Vector {
        let x = balloon.width_in_bars * (self.bars[0].right - self.bars[0].left) * 0.5;
        Vector {
            x,
            y: x * self.aspect,
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
        // Limit relative travel, including rising bars, to half the smallest
        // radius. A fast attack must not cross a rounded cap between checks.
        let minimum_radius = self
            .balloons
            .iter()
            .map(|balloon| geometry.radii(balloon).y)
            .fold(f64::INFINITY, f64::min);
        if minimum_radius <= 0.0 {
            return;
        }
        let speed = self
            .balloons
            .iter()
            .map(|balloon| {
                ((balloon.velocity.x + self.shake.x) * geometry.aspect)
                    .hypot(balloon.velocity.y + self.shake.y)
            })
            .fold(0.0, f64::max);
        let levels = frame
            .levels
            .map(|level| finite(level as f64).clamp(0.0, 1.0) * geometry.bar_height);
        let previous = self.previous_levels;
        let rise = levels
            .iter()
            .zip(previous)
            .map(|(level, previous)| (level - previous).max(0.0))
            .fold(0.0, f64::max);
        let travel = (speed + (GRAVITY + 2.0) * dt) * dt + rise;
        let steps = (travel / (minimum_radius * 0.5)).ceil().max(1.0) as usize;
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
                    bar_contact(candidate, radius.y, *bar, top, geometry, from_above, slop)
                else {
                    continue;
                };
                contacts[band] = true;
                let normal = hit.normal;
                // Resolve from the current position so simultaneous surfaces do
                // not apply the same penetration correction more than once.
                if let Some(correction) = bar_contact(
                    balloon.position,
                    radius.y,
                    *bar,
                    top,
                    geometry,
                    from_above,
                    0.0,
                ) {
                    resolve_bar(balloon, correction, geometry.aspect);
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
                constrain(balloon, geometry, levels, restitution);
                balloon.velocity = balloon.velocity.bounded(MAX_SPEED);
            }
            if overlap < 1e-7 {
                break;
            }
        }
        self.shake = Vector::default();
        self.previous_levels = levels;
    }
}

#[derive(Clone, Copy, Debug)]
struct BarContact {
    /// Unit normal in graph-height coordinates, where circles stay circular.
    normal: Vector,
    depth: f64,
}

/// A bar is a rectangle with circular top corners. Offset its inner rectangle
/// by the corner radius plus the ball radius to get the exact contact surface.
fn bar_contact(
    position: Vector,
    radius: f64,
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
    let x = position.x * geometry.aspect;
    let delta = Vector {
        x: x - x.clamp(left + corner, right - corner),
        y: position.y - position.y.min(top - corner),
    };
    let distance = delta.x.hypot(delta.y);
    if distance > 1e-12 {
        let depth = corner + radius - distance;
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
    let up = top + radius - position.y;
    let to_left = x - left + radius;
    let to_right = right - x + radius;
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

fn resolve_bar(balloon: &mut Balloon, hit: BarContact, aspect: f64) {
    balloon.position.x += hit.normal.x * hit.depth / aspect;
    balloon.position.y += hit.normal.y * hit.depth;
    let inward = balloon.velocity.x * aspect * hit.normal.x + balloon.velocity.y * hit.normal.y;
    if inward < 0.0 {
        balloon.velocity.x -= hit.normal.x * inward / aspect;
        balloon.velocity.y -= hit.normal.y * inward;
    }
}

/// Resolve two circles in graph-height units, including the horizontal aspect
/// ratio. Mass follows circle area; impulses conserve momentum and lose energy.
/// Only bar impacts own color changes, so this operation never touches color.
fn collide(a: &mut Balloon, b: &mut Balloon, geometry: Geometry, restitution: f64) -> f64 {
    let ra = geometry.radii(a).y;
    let rb = geometry.radii(b).y;
    let delta = Vector {
        x: (b.position.x - a.position.x) * geometry.aspect,
        y: b.position.y - a.position.y,
    };
    let distance = delta.x.hypot(delta.y);
    let overlap = ra + rb - distance;
    if overlap < 0.0 {
        return 0.0;
    }
    let normal = if distance > 1e-12 {
        Vector {
            x: delta.x / distance,
            y: delta.y / distance,
        }
    } else {
        Vector { x: 1.0, y: 0.0 }
    };
    let inverse_a = 1.0 / (ra * ra);
    let inverse_b = 1.0 / (rb * rb);
    let share_a = inverse_a / (inverse_a + inverse_b);
    let share_b = 1.0 - share_a;
    a.position.x -= normal.x * overlap * share_a / geometry.aspect;
    a.position.y -= normal.y * overlap * share_a;
    b.position.x += normal.x * overlap * share_b / geometry.aspect;
    b.position.y += normal.y * overlap * share_b;
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
    overlap
}

fn constrain(
    balloon: &mut Balloon,
    geometry: Geometry,
    levels: [f64; DISPLAY_BANDS],
    restitution: f64,
) {
    let radius = geometry.radii(balloon);
    clamp_axis(
        &mut balloon.position.x,
        &mut balloon.velocity.x,
        radius.x,
        restitution,
    );
    // A collision correction can place a body over another surface. Restore
    // support without counting the correction as another bar impact.
    for (band, bar) in geometry.bars.iter().enumerate() {
        if let Some(hit) = bar_contact(
            balloon.position,
            radius.y,
            *bar,
            levels[band],
            geometry,
            true,
            0.0,
        ) {
            resolve_bar(balloon, hit, geometry.aspect);
        }
    }
    // A curved corner can push sideways during surface correction.
    clamp_axis(
        &mut balloon.position.x,
        &mut balloon.velocity.x,
        radius.x,
        restitution,
    );
    clamp_axis(
        &mut balloon.position.y,
        &mut balloon.velocity.y,
        radius.y,
        restitution,
    );
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

fn clamp_axis(position: &mut f64, velocity: &mut f64, radius: f64, restitution: f64) {
    let radius = radius.min(0.5);
    if *position < radius {
        *position = radius;
        if *velocity < 0.0 {
            *velocity = if -*velocity > REST_SPEED {
                -*velocity * restitution
            } else {
                0.0
            };
        }
    } else if *position > 1.0 - radius {
        *position = 1.0 - radius;
        if *velocity > 0.0 {
            *velocity = if *velocity > REST_SPEED {
                -*velocity * restitution
            } else {
                0.0
            };
        }
    }
}

#[cfg(test)]
mod tests;
