//! Decorative browser physics. Coordinates span the balloon layer, with y up.
//! The simulation has no browser dependencies; only the animation owns the DOM.
mod animation;
pub use animation::BalloonAnimation;

use musical_lights_core::{
    audio::visual::{DISPLAY_BANDS, DisplayFrame},
    lights::{Gradient, screen_color},
};

pub const BALLOON_COUNT: usize = 12;
pub const BODY_ASPECT: f64 = 0.82;
const MAX_DT: f64 = 1.0 / 30.0;
const MAX_SPEED: f64 = 0.8;
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
/// a full-height bar. Width/height preserves the body's CSS aspect ratio.
#[derive(Clone, Copy, Debug)]
struct Geometry {
    bars: [Bar; DISPLAY_BANDS],
    bar_height: f64,
    aspect: f64,
}

impl Geometry {
    fn radii(self, balloon: &Balloon) -> Vector {
        let x = balloon.width_in_bars * (self.bars[0].right - self.bars[0].left) * 0.5;
        Vector {
            x,
            y: x * self.aspect / BODY_ASPECT,
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
    elapsed: f64,
}

impl BalloonWorld {
    pub fn new(palette: Gradient<DISPLAY_BANDS>) -> Self {
        let palette = palette.colors.map(|c| [c.red, c.green, c.blue]);
        let widths = [0.55, 1.4, 2.2, 0.8, 3.1, 1.0, 4.0, 1.8, 0.65, 2.6, 1.2, 3.5];
        Self {
            balloons: std::array::from_fn(|i| Balloon {
                width_in_bars: widths[i],
                position: Vector {
                    x: 0.08 + (i % 6) as f64 * 0.16 + (i / 6) as f64 * 0.01,
                    y: 0.52 + (i / 6) as f64 * 0.2 + (i % 3) as f64 * 0.025,
                },
                velocity: Vector::default(),
                color: palette[(i * 7 + 5) % DISPLAY_BANDS],
                contacts: [false; DISPLAY_BANDS],
            }),
            palette,
            previous_levels: [0.0; DISPLAY_BANDS],
            pointer: None,
            wind: Vector::default(),
            target_wind: Vector::default(),
            shake: Vector::default(),
            shake_cooldown: 0.0,
            reduced: false,
            elapsed: 0.0,
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

    fn clear_input(&mut self) {
        self.pointer = None;
        self.wind = Vector::default();
        self.target_wind = Vector::default();
        self.shake = Vector::default();
        self.shake_cooldown = 0.0;
        self.previous_levels.fill(0.0);
        for balloon in &mut self.balloons {
            balloon.velocity = Vector::default();
            balloon.contacts.fill(false);
        }
    }

    fn step(&mut self, dt: f64, frame: DisplayFrame<DISPLAY_BANDS>, geometry: Geometry) {
        let dt = finite(dt).clamp(0.0, MAX_DT);
        if dt == 0.0 {
            return;
        }
        self.elapsed += dt;
        self.shake_cooldown = (self.shake_cooldown - dt).max(0.0);
        let wind_mix = 1.0 - (-dt * 1.5).exp();
        self.wind.x += (self.target_wind.x - self.wind.x) * wind_mix;
        self.wind.y += (self.target_wind.y - self.wind.y) * wind_mix;
        let levels = frame
            .levels
            .map(|level| finite(level as f64).clamp(0.0, 1.0) * geometry.bar_height);
        let motion_scale = if self.reduced { 0.2 } else { 1.0 };
        let damping = (-dt * if self.reduced { 9.0 } else { 2.5 }).exp();
        for (index, balloon) in self.balloons.iter_mut().enumerate() {
            let radius = geometry.radii(balloon);
            let before = balloon.position;
            let mut force = self.wind;
            if !self.reduced {
                // Slow, deterministic float. No random per-frame input.
                force.x += (self.elapsed * 0.7 + index as f64 * 1.9).sin() * 0.018;
                force.y += (self.elapsed * 0.9 + index as f64).cos() * 0.012;
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
            balloon.velocity.x = (balloon.velocity.x + force.x * dt * motion_scale) * damping;
            balloon.velocity.y = (balloon.velocity.y + force.y * dt * motion_scale) * damping;
            balloon.velocity = balloon.velocity.bounded(MAX_SPEED);
            balloon.position.x += balloon.velocity.x * dt;
            balloon.position.y += balloon.velocity.y * dt;
            let incoming = balloon.velocity;
            let candidate = balloon.position;
            let mut contacts = [false; DISPLAY_BANDS];
            // Evaluate all hits from the same candidate position, then resolve
            // and blend in ascending bar order, even for a wide balloon.
            for (band, bar) in geometry.bars.iter().enumerate() {
                let top = levels[band];
                let crossed_side = before.y - radius.y < top
                    && (before.x + radius.x <= bar.left && candidate.x - radius.x >= bar.right
                        || before.x - radius.x >= bar.right && candidate.x + radius.x <= bar.left);
                let slop = if balloon.contacts[band] {
                    CONTACT_SLOP
                } else {
                    0.0
                };
                let overlaps = candidate.x + radius.x >= bar.left - slop
                    && candidate.x - radius.x <= bar.right + slop
                    && candidate.y - radius.y <= top + slop;
                if top <= 0.0 || (!overlaps && !crossed_side) {
                    continue;
                }
                contacts[band] = true;
                let from_above = before.y - radius.y >= self.previous_levels[band] - CONTACT_SLOP;
                let left = candidate.x + radius.x - bar.left;
                let right = bar.right - (candidate.x - radius.x);
                let up = top - (candidate.y - radius.y);
                let sideways =
                    !from_above && (crossed_side || left.min(right) * geometry.aspect < up);
                let normal = if sideways {
                    Vector {
                        x: if before.x < (bar.left + bar.right) * 0.5 {
                            -1.0
                        } else {
                            1.0
                        },
                        y: 0.0,
                    }
                } else {
                    Vector { x: 0.0, y: 1.0 }
                };
                if sideways {
                    balloon.position.x = if normal.x < 0.0 {
                        bar.left - radius.x
                    } else {
                        bar.right + radius.x
                    };
                    if balloon.velocity.x * normal.x < 0.0 {
                        balloon.velocity.x = 0.0;
                    }
                } else {
                    balloon.position.y = balloon.position.y.max(top + radius.y);
                    balloon.velocity.y = balloon.velocity.y.max(0.0);
                }
                let rise = top - self.previous_levels[band];
                if rise > 1e-6 && !balloon.contacts[band] {
                    let approach = (-(incoming.x * normal.x + incoming.y * normal.y)).max(0.0);
                    let impulse = (rise / dt * 0.1 + approach * 0.65).min(0.7);
                    balloon.velocity.x += normal.x * impulse * motion_scale;
                    balloon.velocity.y += normal.y * impulse * motion_scale;
                    balloon.impact_color(self.palette[band], impulse);
                }
            }
            balloon.contacts = contacts;
            balloon.velocity = balloon.velocity.bounded(MAX_SPEED);
            clamp_axis(&mut balloon.position.x, &mut balloon.velocity.x, radius.x);
            // A side correction or wall clamp can place a wide body over another
            // bar. Project above that surface without adding energy or color.
            for (band, bar) in geometry.bars.iter().enumerate() {
                if balloon.position.x + radius.x > bar.left
                    && balloon.position.x - radius.x < bar.right
                    && balloon.position.y - radius.y < levels[band]
                {
                    balloon.position.y = levels[band] + radius.y;
                    balloon.velocity.y = balloon.velocity.y.max(0.0);
                }
            }
            clamp_axis(&mut balloon.position.y, &mut balloon.velocity.y, radius.y);
        }
        self.shake = Vector::default();
        self.previous_levels = levels;
    }
}

fn finite(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

fn clamp_axis(position: &mut f64, velocity: &mut f64, radius: f64) {
    let radius = radius.min(0.5);
    if *position < radius {
        *position = radius;
        *velocity = velocity.max(0.0);
    } else if *position > 1.0 - radius {
        *position = 1.0 - radius;
        *velocity = velocity.min(0.0);
    }
}

#[cfg(test)]
mod tests;
