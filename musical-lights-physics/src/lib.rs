//! Fixed-step SI-unit simulation, shared without browser APIs by native tests and WASM.
use musical_lights_core::lights::bar_motion::{DEFAULT_ATTACK_SECONDS, Motion};
use musical_lights_core::lights::bar_surface::{BarSurface, JOIN_FRACTION};
use musical_lights_core::lights::dance::{DanceMotion, flight_height, release_speed};
use musical_lights_core::lights::musical_motion::{
    DirectionOdds, advance_pigment, contact_pigment_blend, paired_bar_extent, pigment_color,
    sphere_drag_factor,
};
use rapier3d::{na::Unit, prelude::*};
use wasm_bindgen::prelude::*;

mod prism;
use prism::RampPrism;

pub const COUNT: usize = 24;
pub const ATTACK_OFFSET: usize = 38;
pub const DEPTH_INPUT: usize = ATTACK_OFFSET + COUNT;
pub const INPUT_LEN: usize = DEPTH_INPUT + 1;
pub const BALL_COUNT: usize = 8;
pub const HZ: u32 = 120;
pub const DT: f32 = 1.0 / HZ as f32;
pub const WIDTH: f32 = 1.2;
pub const PITCH: f32 = WIDTH / COUNT as f32;
// Keep the existing beach-ball sizes independent of the now full-width bars.
pub const BALL_SIZE_UNIT: f32 = PITCH - 0.002;
const BRIDGE_WIDTH: f32 = PITCH * JOIN_FRACTION as f32;
const CAP_WIDTH: f32 = PITCH - BRIDGE_WIDTH;
const SURFACE_END_COUNT: usize = COUNT * 3 * 2;
const SURFACE_COUNT: usize = SURFACE_END_COUNT * 2;
fn ramp_width(index: usize) -> f32 {
    if index.is_multiple_of(2) {
        CAP_WIDTH
    } else {
        BRIDGE_WIDTH
    }
}
pub const POST_HEIGHT: f32 = 20.0;
pub const MAX_SUBSTEPS: usize = 128;
pub const MIN_HEIGHT: f32 = 0.40;
pub const RESIZE_TICKS: u32 = HZ * 3 / 10;
pub const CLEARANCE: f32 = 0.004;
pub const BASELINE: f32 = 0.003;
pub const WALL_RESTITUTION: f32 = 0.55;
pub const SIZE_RATIOS: [f32; BALL_COUNT] = [0.55, 1.4, 2.2, 0.8, 3.1, 1.0, 4.0, 1.8];
pub const BODY_STRIDE: usize = 18;
pub const BAR_OFFSET: usize = 3 + BALL_COUNT * BODY_STRIDE;
pub const IMPULSE_OFFSET: usize = BAR_OFFSET + COUNT;
pub const CONTACT_OFFSET: usize = IMPULSE_OFFSET + BALL_COUNT * COUNT;
pub const VELOCITY_OFFSET: usize = CONTACT_OFFSET + BALL_COUNT;
pub const COST_OFFSET: usize = VELOCITY_OFFSET + COUNT;
pub const GEOMETRY_OFFSET: usize = COST_OFFSET + 4;
pub const SCROLL_OFFSET: usize = GEOMETRY_OFFSET + 5;
pub const SNAPSHOT_LEN: usize = SCROLL_OFFSET + 1;
pub use musical_lights_core::lights::musical_motion::{
    SCROLL_EASE, SCROLL_PEAK_SPEED, SCROLL_SPEED,
};

/// Adjacent prisms describe one surface. Their end faces lie inside that solid
/// and must not act as extra walls. At a shared convex vertex, both
/// chords have the same closest point. Keep one owner of that contact so
/// separate manifolds cannot turn the other's rebound into a resting contact.
/// Concave joins retain both contacts: their closest points are distinct.
struct JoinedSurface<'a> {
    bars: &'a [(RigidBodyHandle, ColliderHandle)],
    velocities: &'a [f64; COUNT],
    inv_dt: f32,
}
fn chord_points(collider: &Collider) -> (Vector, Vector) {
    let points = collider
        .shape()
        .as_shape::<RampPrism>()
        .expect("ramp prism")
        .points();
    let pose = collider.position();
    (
        (pose * points[0] + pose * points[4]) / 2.0,
        (pose * points[1] + pose * points[5]) / 2.0,
    )
}
// During collision detection the prism already has its next tangent length,
// while its rigid frame still has the current angle. Its current material
// interval retains its fixed horizontal width, independent of that length change.
fn material_endpoints(body: &RigidBody, width: f32) -> (Vector, Vector) {
    let left = body.translation();
    let tangent = body.rotation() * Vector::X;
    (left, left + tangent * (width / tangent.x))
}

fn ramp_surface_flow(
    body: &RigidBody,
    point: Vector,
    vertical_delta: f32,
    inv_dt: f32,
    width: f32,
) -> Vector {
    let frame = RigidBodyPosition {
        position: *body.position(),
        next_position: *body.next_position(),
    }
    .interpolate_velocity(inv_dt, Vector::ZERO);
    let fraction = ((point.x - body.translation().x) / width).clamp(0.0, 1.0);
    // The material origin follows the endpoint displacement exactly. Rapier's
    // general pose-error composition can add coordinate roundoff to its
    // interpolated translation when the frame also rotates.
    let origin_velocity = (body.next_position().translation - body.translation()) * inv_dt;
    let material = Vector::new(
        origin_velocity.x,
        origin_velocity.y + fraction * vertical_delta,
        0.0,
    );
    material - frame.velocity_at_point(point, body.translation())
}

// Solver contacts retain their pre-step world point. Use that same rigid
// lever arm and deformation flow when deciding whether the support is driven.
fn ramp_contact_velocity(body: &RigidBody, point: Vector, flow: Vector, dt: f32) -> Vector {
    let frame = RigidBodyVelocity {
        linvel: body.linvel(),
        angvel: body.angvel(),
    };
    let previous_origin = body.translation() - frame.linvel * dt;
    frame.velocity_at_point(point, previous_origin) + flow
}

impl PhysicsHooks for JoinedSurface<'_> {
    fn modify_solver_contacts(&self, context: &mut ContactModificationContext<'_>) {
        let first = &context.colliders[context.collider1];
        let second = &context.colliders[context.collider2];
        let (surface, ball) = if first.user_data >> 16 != 0 && second.shape().as_ball().is_some() {
            (first, second)
        } else if second.user_data >> 16 != 0 && first.shape().as_ball().is_some() {
            (second, first)
        } else {
            return;
        };
        let is_first = first.user_data >> 16 != 0;
        let sign = if (surface.user_data & 0xffff) as usize <= COUNT * 2 {
            1.0
        } else {
            -1.0
        };
        // The chord frame puts the real top at local y=0. Side and bottom
        // contacts below it are buried in the joined solid. Keep the outer
        // top, including its front/back edges at the enclosure walls.
        context.solver_contacts.retain(|contact| {
            let tracked = &context.manifold.points[contact.contact_id[0] as usize];
            let point = if is_first {
                tracked.local_p1
            } else {
                tracked.local_p2
            };
            sign * point.y >= -0.000002
        });
        if context.solver_contacts.is_empty() {
            return;
        }
        let index = (surface.user_data >> 16) as usize - 1;
        let end_start = index / (SURFACE_END_COUNT) * SURFACE_END_COUNT;
        let end_len = SURFACE_END_COUNT;
        let body = &context.bodies[surface.parent().expect("prescribed ramp")];
        let (left, right) = material_endpoints(body, ramp_width(index));
        let centre = ball.position().translation;
        let edge = right - left;
        let along = (centre - left).dot(edge);
        if along <= 0.0 {
            let previous = end_start + (index - end_start + end_len - 1) % end_len;
            let previous_index = previous;
            let (previous, _) = self.bars[previous];
            if context.bodies[previous].is_enabled() {
                let (before, join) =
                    material_endpoints(&context.bodies[previous], ramp_width(previous_index));
                if (join - left).length_squared() <= 1e-10
                    && (centre - join).dot(join - before) < 0.0
                {
                    // The preceding face has the closer interior point.
                    context.solver_contacts.clear();
                }
            }
        } else if along >= edge.length_squared() {
            let next = end_start + (index - end_start + 1) % end_len;
            let next_index = next;
            let (next, _) = self.bars[next];
            if context.bodies[next].is_enabled() {
                let (join, _) = material_endpoints(&context.bodies[next], ramp_width(next_index));
                if (join - right).length_squared() <= 1e-10 {
                    // The next face either has the closer interior point or
                    // owns the shared vertex at its material frame origin.
                    // That origin carries the vertex's real normal velocity,
                    // including the first impact on a rapidly rising peak.
                    context.solver_contacts.clear();
                }
            }
        }
        if context.solver_contacts.is_empty() {
            return;
        }
        // Weld the sphere contact to the current material interval. Shape
        // length changes along the tangent before Rapier advances its frame;
        // its raw endpoint can therefore be ahead of the shared knot.
        let fraction = (along / edge.length_squared()).clamp(0.0, 1.0);
        let mut nearest = left + edge * fraction;
        let depth = surface
            .shape()
            .as_shape::<RampPrism>()
            .expect("ramp prism")
            .points()[4]
            .z;
        nearest.z = centre.z.clamp(-depth, depth);
        let delta = centre - nearest;
        let face_normal = Vector::new(-edge.y, edge.x, 0.0).normalize() * sign;
        let normal = if fraction > 0.0 && fraction < 1.0 && centre.z.abs() <= depth {
            face_normal
        } else {
            let radial = delta.try_normalize().unwrap_or(face_normal);
            if radial.dot(face_normal) >= 0.0 {
                radial
            } else {
                -radial
            }
        };
        let separation = delta.dot(normal) - ball.shape().as_ball().expect("sphere").radius;
        let previous_normal = *context.normal;
        *context.normal = if is_first { normal } else { -normal };
        let alignment = previous_normal.dot(*context.normal).max(0.0);
        for contact in context.solver_contacts.iter_mut() {
            contact.point = nearest + normal * (separation * 0.5);
            contact.dist = separation;
            contact.warmstart_impulse *= alignment;
            contact.warmstart_tangent_impulse *= alignment;
            contact.warmstart_twist_impulse *= alignment;
        }
        let band = index / 2 % COUNT;
        let delta = if index.is_multiple_of(2) {
            0.0
        } else {
            sign * (self.velocities[(band + 1) % COUNT] - self.velocities[band]) as f32
        };
        for contact in context.solver_contacts.iter_mut() {
            // Rapier models this as additional movement of the first surface.
            // Supply the ramp's material deformation relative to its rigid
            // frame, with the matching sign when the ramp is collider two.
            let flow =
                ramp_surface_flow(body, contact.point, delta, self.inv_dt, ramp_width(index));
            contact.tangent_velocity = if is_first { flow } else { -flow };
        }
    }
}

/// A vertical-sided prism below one straight ramp. Its rigid frame follows
/// a stable material endpoint and angle. Chord stretch changes the shape
/// along its tangent, with no additional normal surface velocity.
struct SurfaceSegment {
    pose: Pose,
    width: f32,
    delta: f32,
    height: f32,
    depth: f32,
    sign: f32,
}
fn surface_segment(
    x: f32,
    left: f32,
    right: f32,
    end: usize,
    height: f32,
    depth: f32,
    width: f32,
) -> SurfaceSegment {
    let sign = if end == 0 { 1.0 } else { -1.0 };
    let delta = sign * (right - left);
    let y = if end == 0 { left } else { height - left };
    let rotation = Rotation::from_rotation_z(delta.atan2(width));
    SurfaceSegment {
        pose: Pose::from_parts(Vector::new(x, y, 0.0), rotation),
        width,
        delta,
        height,
        depth,
        sign,
    }
}
impl SurfaceSegment {
    fn shape(self) -> SharedShape {
        let inverse = self.pose.rotation.inverse();
        let Self {
            width,
            delta,
            height,
            depth,
            sign,
            ..
        } = self;
        let points = std::array::from_fn(|i| {
            let z = if i < 4 { -depth / 2.0 } else { depth / 2.0 };
            inverse
                * match i % 4 {
                    0 => Vector::new(0.0, 0.0, z),
                    1 => Vector::new(width, delta, z),
                    2 => Vector::new(width, -sign * height, z),
                    _ => Vector::new(0.0, -sign * height, z),
                }
        });
        SharedShape::new(RampPrism::new(points, sign))
    }
}

/// Prototype assumptions, not measured material properties. Changes require a new world.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimulationConfig {
    pub height: f32,
    pub gravity: f32,
    pub density: f32,
    pub restitution: f32,
    pub friction: f32,
    pub depth: f32,
    pub stroke_seconds: f32,
    pub reduced_stroke_seconds: f32,
}
impl Default for SimulationConfig {
    fn default() -> Self {
        Self {
            height: 0.6,
            gravity: 9.81,
            density: 8.0,
            restitution: 0.72,
            friction: 0.12,
            depth: 0.48,
            stroke_seconds: DEFAULT_ATTACK_SECONDS as f32,
            reduced_stroke_seconds: 0.320,
        }
    }
}
impl SimulationConfig {
    pub fn hop_height(self, reduced: bool) -> f32 {
        let diameter = SIZE_RATIOS.iter().copied().fold(0.0_f32, f32::max) * BALL_SIZE_UNIT;
        flight_height(self.height - diameter - CLEARANCE, 0.3, reduced)
    }
    pub fn bar_max(self) -> f32 {
        // Keep the same geometry in Reduced Motion: only the release energy changes.
        paired_bar_extent(
            self.height,
            SIZE_RATIOS.iter().copied().fold(0.0_f32, f32::max) * BALL_SIZE_UNIT
                + self.hop_height(false)
                + CLEARANCE,
        )
    }
    pub fn motion_limits(self, reduced: bool) -> (f64, f64) {
        let height = f64::from(self.bar_max() - BASELINE);
        let time = f64::from(if reduced {
            self.reduced_stroke_seconds
        } else {
            self.stroke_seconds
        });
        (2.2 * height / time, 12.0 * height / (time * time))
    }
    pub fn values(self) -> [f32; 8] {
        [
            self.height,
            self.gravity,
            self.density,
            self.restitution,
            self.friction,
            self.depth,
            self.stroke_seconds,
            self.reduced_stroke_seconds,
        ]
    }
    pub fn from_values(v: &[f32]) -> Result<Self, &'static str> {
        if v.len() != 8 || v.iter().any(|v| !v.is_finite()) {
            return Err("Invalid physics configuration");
        }
        let c = Self {
            height: v[0],
            gravity: v[1],
            density: v[2],
            restitution: v[3],
            friction: v[4],
            depth: v[5],
            stroke_seconds: v[6],
            reduced_stroke_seconds: v[7],
        };
        if !(MIN_HEIGHT..=20.0).contains(&c.height)
            || !(0.0..=30.0).contains(&c.gravity)
            || !(1.0..=20000.0).contains(&c.density)
            || !(0.0..=1.0).contains(&c.restitution)
            || !(0.0..=2.0).contains(&c.friction)
            || !(0.2..=2.0).contains(&c.depth)
            || !(0.02..=2.0).contains(&c.stroke_seconds)
            || !(0.32..=4.0).contains(&c.reduced_stroke_seconds)
        {
            return Err("Physics settings are outside the prototype limits");
        }
        Ok(c)
    }
}

/// Complete held input state at a physics tick. Sensor acceleration is m/s².
/// Pointer force is a radial field expressed as acceleration, then multiplied by mass.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimulationInput {
    pub tick: u64,
    pub levels: [f32; COUNT],
    /// Current audio attack edges, separate from physical and decorative travel.
    pub attacks: [f32; COUNT],
    pub acceleration: [f32; 3],
    pub gravity: Option<[f32; 3]>,
    pub pointer: Option<[f32; 3]>,
    pub reduced_motion: bool,
    pub height: f32,
    pub depth: f32,
    pub scrolling: bool,
}
impl Default for SimulationInput {
    fn default() -> Self {
        Self {
            tick: 0,
            levels: [0.0; COUNT],
            attacks: [0.0; COUNT],
            acceleration: [0.0; 3],
            gravity: None,
            pointer: None,
            reduced_motion: false,
            height: SimulationConfig::default().height,
            depth: SimulationConfig::default().depth,
            scrolling: false,
        }
    }
}

/// Packed snapshot: time/height/tick, then 8 bodies (position, quaternion, radius,
/// mass, linear velocity, angular velocity, linear-sRGB), 24 actual bar tops,
/// 8×24 normal bar impulses in N·s, and each ball's total normal contact impulse.
#[derive(Clone, Debug, PartialEq)]
pub struct SimulationSnapshot {
    pub values: [f32; SNAPSHOT_LEN],
}

pub struct Simulation {
    pub config: SimulationConfig,
    pub tick: u64,
    world: PhysicsWorld,
    balls: [(RigidBodyHandle, ColliderHandle); BALL_COUNT],
    bars: Vec<(RigidBodyHandle, ColliderHandle)>,
    surface: BarSurface<COUNT>,
    surface_deltas: Vec<f32>,
    surface_dimensions: Vec<[f32; 2]>,
    bar_positions: [f64; COUNT],
    bar_velocities: [f64; COUNT],
    motions: [Motion; COUNT],
    tempo: f64,
    scroll_phase: f64,
    scroll_speed: f64,
    dance: DanceMotion,
    flight_fraction: f32,
    flight_target: f32,
    accent_sequence: u32,
    palette: [[f32; 3]; COUNT],
    // Contact targets; visible surface colors fill toward these at fixed ticks.
    colors: [[f32; 3]; BALL_COUNT],
    pigments: [f32; BALL_COUNT * 9],
    touching: [[bool; COUNT]; BALL_COUNT],
    ceiling: RigidBodyHandle,
    depth_walls: [RigidBodyHandle; 2],
    ceiling_height: f32,
    resize_from: f32,
    resize_tick: u32,
    supported: [[bool; BALL_COUNT]; 2],
    driven: [[bool; BALL_COUNT]; 2],
    input: SimulationInput,
    snapshot: SimulationSnapshot,
}
impl Simulation {
    pub fn new(config: SimulationConfig, palette: [[f32; 3]; COUNT]) -> Result<Self, &'static str> {
        SimulationConfig::from_values(&config.values())?;
        if palette
            .iter()
            .flatten()
            .any(|c| !c.is_finite() || !(0.0..=1.0).contains(c))
        {
            return Err("Invalid ball palette");
        }
        let mut world = PhysicsWorld {
            gravity: Vector::new(0.0, -config.gravity, 0.0),
            integration_parameters: IntegrationParameters {
                dt: DT,
                num_solver_iterations: 8,
                num_internal_stabilization_iterations: 8,
                max_ccd_substeps: 1,
                // Rapier's default assumes a 60 Hz step; our contact substeps
                // can be smaller than that default minimum CCD interval.
                min_ccd_dt: DT / MAX_SUBSTEPS as f32 / 100.0,
                // Ordinary contacts retain the original restitution response.
                contact_softness: SpringCoefficients {
                    natural_frequency: 60.0,
                    ..SpringCoefficients::contact_defaults()
                },
                // Default metre-scale tolerances are larger than our smallest sphere.
                normalized_allowed_linear_error: 0.0002,
                normalized_prediction_distance: 0.002,
                friction_model: FrictionModel::Coulomb,
                ..IntegrationParameters::default()
            },
            ..PhysicsWorld::default()
        };
        // Closed enclosure: every visible boundary has a physical collider.
        let boundaries = [
            (Vector::Y, Vector::ZERO),
            (Vector::X, Vector::ZERO),
            (-Vector::X, Vector::new(WIDTH, 0.0, 0.0)),
            (Vector::Z, Vector::new(0.0, 0.0, -config.depth / 2.0)),
            (-Vector::Z, Vector::new(0.0, 0.0, config.depth / 2.0)),
        ]
        .map(|(normal, position)| {
            // Vertical walls shed tangential load instead of pinning spheres.
            // Keep the floor, ceiling, balls and bars on the configured material.
            let vertical = normal.y == 0.0;
            world
                .insert(
                    RigidBodyBuilder::fixed().translation(position),
                    ColliderBuilder::halfspace(Unit::new_unchecked(normal))
                        .friction(if vertical { 0.0 } else { config.friction })
                        .friction_combine_rule(if vertical {
                            CoefficientCombineRule::Min
                        } else {
                            CoefficientCombineRule::Average
                        })
                        .restitution(if vertical {
                            WALL_RESTITUTION
                        } else {
                            config.restitution
                        })
                        .restitution_combine_rule(if vertical {
                            CoefficientCombineRule::Max
                        } else {
                            CoefficientCombineRule::Average
                        }),
                )
                .0
        });
        let (ceiling, _) = world.insert(
            RigidBodyBuilder::fixed().translation(Vector::new(0.0, config.height, 0.0)),
            ColliderBuilder::halfspace(Unit::new_unchecked(-Vector::Y))
                .friction(config.friction)
                .restitution(config.restitution),
        );
        let bars: Vec<_> = (0..SURFACE_COUNT)
            .map(|index| {
                let column = index / 2;
                let end = index / SURFACE_END_COUNT;
                let x = ((column % COUNT) as f32 + 0.5) * PITCH
                    + ((column / COUNT + 1) % 3) as f32 * WIDTH
                    - WIDTH;
                let segment = surface_segment(
                    x - CAP_WIDTH / 2.0
                        + if index.is_multiple_of(2) {
                            0.0
                        } else {
                            CAP_WIDTH
                        },
                    BASELINE,
                    BASELINE,
                    end,
                    config.height,
                    config.depth,
                    ramp_width(index),
                );
                world.insert(
                    RigidBodyBuilder::kinematic_position_based().pose(segment.pose),
                    ColliderBuilder::new(segment.shape())
                        // Prescribed frames rotate about their material endpoint.
                        // A volume-derived COM creates a false endpoint velocity
                        // during finite-step rotation and unnecessary mass updates.
                        .mass_properties(MassProperties::default())
                        .user_data(
                            ((index as u128 + 1) << 16)
                                | (COUNT + 1 + end * COUNT + column % COUNT) as u128,
                        )
                        .active_hooks(ActiveHooks::MODIFY_SOLVER_CONTACTS)
                        .friction(config.friction)
                        .restitution(config.restitution),
                )
            })
            .collect();
        let mut order: [usize; BALL_COUNT] = std::array::from_fn(|i| i);
        order.sort_by(|&a, &b| SIZE_RATIOS[b].total_cmp(&SIZE_RATIOS[a]).then(a.cmp(&b)));
        let mut spawn = [Vector::ZERO; BALL_COUNT];
        let mut bottom = BASELINE + 0.002;
        for (row_index, row) in order.chunks(6).enumerate() {
            let diameter = SIZE_RATIOS[row[0]] * BALL_SIZE_UNIT;
            for (column, &i) in row.iter().enumerate() {
                let radius = SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0;
                let side = if (column + row_index).is_multiple_of(2) {
                    1.0
                } else {
                    -1.0
                };
                // Use the actual depth, avoiding perfectly collinear stacks
                // that cannot spread sideways when every bar rises at once.
                let shift = if row_index == 0 {
                    0.0
                } else if row_index.is_multiple_of(2) {
                    -0.04
                } else {
                    0.04
                };
                spawn[i] = Vector::new(
                    column as f32 * 0.2 + 0.1 + shift,
                    bottom + radius,
                    side * (config.depth / 2.0 - radius - 0.002) * 0.8,
                );
            }
            bottom += diameter + 0.002;
        }
        let balls = std::array::from_fn(|i| {
            let radius = SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0;
            world.insert(
                RigidBodyBuilder::dynamic()
                    .translation(spawn[i])
                    .angular_damping(0.15)
                    .ccd_enabled(true),
                ColliderBuilder::ball(radius)
                    .user_data((i + 1) as u128)
                    .density(config.density)
                    .friction(config.friction)
                    .restitution(config.restitution),
            )
        });
        let colors = std::array::from_fn(|i| {
            let band = ((spawn[i].x / PITCH) as usize).min(COUNT - 1);
            palette[band]
        });
        let mut sim = Self {
            config,
            tick: 0,
            world,
            balls,
            bars,
            surface: BarSurface::new(&[f64::from(BASELINE); COUNT]),
            surface_deltas: vec![0.0; SURFACE_COUNT],
            surface_dimensions: vec![[config.height, config.depth]; SURFACE_COUNT],
            palette,
            colors,
            // Start uniformly with the source band under the actual spawn X.
            // Contact targets spread through these surface regions over time.
            pigments: std::array::from_fn(|i| colors[i / 9][i % 3]),
            bar_positions: [f64::from(BASELINE); COUNT],
            bar_velocities: [0.0; COUNT],
            motions: [Motion::default(); COUNT],
            tempo: 120.0,
            scroll_phase: 0.0,
            scroll_speed: 0.0,
            dance: DanceMotion::new(1),
            flight_fraction: 0.3,
            flight_target: 0.3,
            accent_sequence: 0,
            touching: [[false; COUNT]; BALL_COUNT],
            ceiling,
            depth_walls: [boundaries[3], boundaries[4]],
            ceiling_height: config.height,
            resize_from: config.height,
            resize_tick: RESIZE_TICKS,
            supported: [[false; BALL_COUNT]; 2],
            driven: [[false; BALL_COUNT]; 2],
            input: SimulationInput {
                height: config.height,
                depth: config.depth,
                ..SimulationInput::default()
            },
            snapshot: SimulationSnapshot {
                values: [0.0; SNAPSHOT_LEN],
            },
        };
        sim.write_transforms();
        Ok(sim)
    }
    pub fn apply(&mut self, input: SimulationInput) -> Result<(), &'static str> {
        if input.tick != self.tick
            || input
                .levels
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
            || input
                .attacks
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
            || input.acceleration.iter().any(|v| !v.is_finite())
            || input
                .gravity
                .is_some_and(|g| g.iter().any(|v| !v.is_finite()))
            || input
                .pointer
                .is_some_and(|p| p.iter().any(|v| !v.is_finite()))
            || !input.height.is_finite()
            || !(MIN_HEIGHT..=20.0).contains(&input.height)
            || !input.depth.is_finite()
            || !(0.2..=2.0).contains(&input.depth)
        {
            return Err("Invalid or late simulation input");
        }
        // The input requests a room size; snapshots/config report the applied size.
        // Retarget from the current height, without touching body momentum.
        if input.height != self.input.height {
            self.resize_from = self.config.height;
            self.resize_tick = 0;
        }
        self.input = input;
        Ok(())
    }
    /// Separate from the stable input layout and loudness/target snapshots.
    /// The active hardware-neutral presentation policy.
    pub fn configure_dance(
        &mut self,
        odds: [f64; 5],
        flight: f32,
        seed: u32,
        scroll_speed: f64,
    ) -> Result<(), &'static str> {
        if !flight.is_finite()
            || !(0.0..=0.5).contains(&flight)
            || !scroll_speed.is_finite()
            || !(0.25..=8.0).contains(&scroll_speed)
        {
            return Err("Invalid dance settings");
        }
        let odds = DirectionOdds::new(odds)?;
        if self.tick == 0 {
            self.dance = DanceMotion::new(seed);
        }
        self.dance.odds = odds;
        self.dance.columns_per_beat = scroll_speed;
        self.dance.tempo = self.tempo;
        self.flight_target = flight;
        if self.tick == 0 {
            self.flight_fraction = flight;
        }
        Ok(())
    }
    pub fn accent(&mut self, sequence: u32) -> Result<(), &'static str> {
        let count = sequence.saturating_sub(self.accent_sequence);
        if !self.input.reduced_motion && self.input.scrolling {
            if count > 256 {
                return Err("Too many unconsumed motion accents");
            }
            for _ in 0..count {
                self.dance.choose();
            }
        }
        self.accent_sequence = sequence;
        Ok(())
    }
    fn hop_height(&self, reduced: bool) -> f32 {
        let diameter = SIZE_RATIOS.iter().copied().fold(0.0_f32, f32::max) * BALL_SIZE_UNIT;
        flight_height(
            self.config.height - diameter - CLEARANCE,
            self.flight_fraction,
            reduced,
        )
    }
    fn bar_max(&self) -> f32 {
        self.config.bar_max() + (self.config.hop_height(false) - self.hop_height(false)) * 0.5
    }
    pub fn set_tempo(&mut self, bpm: f32) {
        if bpm.is_finite() {
            self.tempo = f64::from(bpm.clamp(60.0, 200.0));
            self.dance.tempo = self.tempo;
        }
    }
    pub fn step(&mut self) {
        let gravity = self.input.gravity.map_or(
            Vector::new(0.0, -self.config.gravity, 0.0),
            Vector::from_array,
        );
        if gravity != self.world.gravity {
            self.world.gravity = gravity;
            // A resting body must respond when the phone turns over.
            for &(handle, _) in &self.balls {
                self.world.bodies[handle].wake_up(true);
            }
        }
        self.resize_depth();
        let old_travel = f64::from(self.bar_max() - BASELINE);
        self.flight_fraction +=
            (self.flight_target - self.flight_fraction).clamp(-0.5 * DT / 0.3, 0.5 * DT / 0.3);
        if self.resize_tick < RESIZE_TICKS {
            self.resize_tick += 1;
            let t = self.resize_tick as f32 / RESIZE_TICKS as f32;
            self.config.height = if self.resize_tick == RESIZE_TICKS {
                self.input.height
            } else {
                self.resize_from + (self.input.height - self.resize_from) * t * t * (3.0 - 2.0 * t)
            };
        }
        let (max_speed, acceleration) = self.config.motion_limits(self.input.reduced_motion);
        let travel = f64::from(self.bar_max() - BASELINE);
        for (i, motion) in self.motions.iter_mut().enumerate() {
            motion.retarget(
                f64::from(self.input.levels[i]),
                f64::from(self.config.stroke_seconds),
                self.input.reduced_motion,
                f64::from(self.config.reduced_stroke_seconds),
            );
        }
        let enabled = self.input.scrolling && !self.input.reduced_motion;
        let resize_speed = (travel - old_travel).abs() / f64::from(DT);
        let bar_speeds: [f64; COUNT] = std::array::from_fn(|i| {
            let motion = &self.motions[i];
            (0..=32)
                .map(|j| {
                    motion
                        .sample(f64::from(DT) * j as f64 / 32.0)
                        .velocity
                        .abs()
                        * travel
                })
                .fold(0.0_f64, f64::max)
                + resize_speed
                + SCROLL_PEAK_SPEED * (self.tempo / 120.0) * f64::from(PITCH)
        });
        let ball_speed = self
            .balls
            .iter()
            .filter_map(|&(h, _)| {
                let b = &self.world.bodies[h];
                b.is_enabled().then_some(f64::from(b.linvel().length()))
            })
            .fold(0.0_f64, f64::max);
        // A fast post in empty space does not require every contact in the room
        // to be solved at its speed. Conservative swept bounds include a whole
        // tick of both bodies' travel plus force/contact prediction margins.
        let force_bound = self.world.gravity.length()
            + Vector::from_array(self.input.acceleration).length()
            + if self.input.pointer.is_some() {
                15.0
            } else {
                0.0
            };
        let margin = 0.002 + f64::from(force_bound) * f64::from(DT).powi(2);
        let ball_reach = ball_speed * f64::from(DT) + margin;
        let bar_speed = self
            .bars
            .iter()
            .enumerate()
            .filter_map(|(copy, &(h, _))| {
                let post = &self.world.bodies[h];
                let column = copy / 2;
                let band = column % COUNT;
                let speed = bar_speeds[(band + COUNT - 1) % COUNT]
                    .max(bar_speeds[band])
                    .max(bar_speeds[(band + 1) % COUNT]);
                let reach_x = f64::from(PITCH) + SCROLL_PEAK_SPEED * f64::from(PITCH * DT);
                let top = self.bar_positions[(band + COUNT - 1) % COUNT]
                    .max(self.bar_positions[band])
                    .max(self.bar_positions[(band + 1) % COUNT])
                    + speed * f64::from(DT);
                self.balls
                    .iter()
                    .enumerate()
                    .any(|(i, &(ball, _))| {
                        let body = &self.world.bodies[ball];
                        let radius = f64::from(SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0);
                        body.is_enabled()
                            && f64::from((body.translation().x - post.translation().x).abs())
                                <= reach_x + radius + ball_reach
                            && if copy >= SURFACE_END_COUNT {
                                f64::from(body.translation().y) + radius + ball_reach
                                    >= f64::from(self.ceiling_height) - top
                            } else {
                                f64::from(body.translation().y) - radius - ball_reach <= top
                            }
                    })
                    .then_some(speed)
            })
            .fold(resize_speed, f64::max);
        let min_radius =
            SIZE_RATIOS.iter().copied().fold(f32::INFINITY, f32::min) * BALL_SIZE_UNIT / 2.0;
        // Bound each kind of contact: two opposing balls, or a ball and a post.
        // Adding all three speeds double-counts the ball for post contacts and
        // makes unrelated ball-ball contacts pay for the fastest nearby post.
        // Recompute deterministically each outer tick, never from wall-clock cost.
        let relative_speed = (2.0 * ball_speed).max(ball_speed + bar_speed);
        let required = (((relative_speed + 1.0) * f64::from(DT) / f64::from(min_radius * 0.5))
            .ceil() as usize)
            .max(1);
        let substeps = required.min(MAX_SUBSTEPS);
        let dt = DT / substeps as f32;
        self.world.integration_parameters.dt = dt;
        self.snapshot.values[IMPULSE_OFFSET..VELOCITY_OFFSET].fill(0.0);
        self.snapshot.values[COST_OFFSET] = substeps as f32;
        self.snapshot.values[COST_OFFSET + 1] = required.saturating_sub(MAX_SUBSTEPS) as f32;
        self.snapshot.values[COST_OFFSET + 2] = max_speed as f32;
        self.snapshot.values[COST_OFFSET + 3] = acceleration as f32;
        for substep in 0..substeps {
            let previous_surface = self.surface;
            let previous_ceiling = self.ceiling_height;
            self.resize_ceiling();
            let distance = self.dance.advance(enabled, self.tempo, f64::from(dt));
            self.scroll_speed = self.dance.speed();
            self.scroll_phase = (self.scroll_phase + distance).rem_euclid((COUNT * 3) as f64);
            let scale = old_travel + (travel - old_travel) * (substep + 1) as f64 / substeps as f64;
            for i in 0..COUNT {
                self.motions[i].advance(f64::from(dt));
                let next = f64::from(BASELINE) + self.motions[i].state.position * scale;
                self.bar_velocities[i] = (next - self.bar_positions[i]) / f64::from(dt);
                self.bar_positions[i] = next;
            }
            self.surface = BarSurface::new(&self.bar_positions);
            for (index, &(handle, collider)) in self.bars.iter().enumerate() {
                let column = index / 2;
                let band = column % COUNT;
                let x = ((band as f64
                    + 0.5
                    + self.scroll_phase
                    + (column / COUNT % 3 + 1) as f64 * COUNT as f64)
                    .rem_euclid((COUNT * 3) as f64)
                    - COUNT as f64)
                    * f64::from(PITCH);
                let x = x as f32 - CAP_WIDTH / 2.0
                    + if index.is_multiple_of(2) {
                        0.0
                    } else {
                        CAP_WIDTH
                    };
                let body = &mut self.world.bodies[handle];
                let active = (-ramp_width(index)..=WIDTH).contains(&x);
                if !active {
                    body.set_enabled(false);
                    continue;
                }
                let left = self.surface.sample(band, 0.0) as f32;
                let right_fraction = if index.is_multiple_of(2) { 0.0 } else { 1.0 };
                let right = self.surface.sample(band, right_fraction) as f32;
                let segment = surface_segment(
                    x,
                    left,
                    right,
                    index / SURFACE_END_COUNT,
                    self.ceiling_height,
                    self.config.depth,
                    ramp_width(index),
                );
                let pose = segment.pose;
                if !body.is_enabled() || (body.translation().x - pose.translation.x).abs() > WIDTH {
                    // Reactivated ramps must keep the real
                    // surface velocity, rather than start at rest at the target.
                    let previous = surface_segment(
                        x - (distance * f64::from(PITCH)) as f32,
                        previous_surface.sample(band, 0.0) as f32,
                        previous_surface.sample(band, right_fraction) as f32,
                        index / SURFACE_END_COUNT,
                        previous_ceiling,
                        self.config.depth,
                        ramp_width(index),
                    );
                    body.set_position(previous.pose, false);
                }
                body.set_enabled(true);
                if self.surface_deltas[index] != right - left
                    || self.surface_dimensions[index] != [self.ceiling_height, self.config.depth]
                {
                    self.world.colliders[collider].set_shape(segment.shape());
                    self.surface_deltas[index] = right - left;
                    self.surface_dimensions[index] = [self.ceiling_height, self.config.depth];
                }
                body.set_next_kinematic_position(pose);
            }
            for (i, &(handle, _)) in self.balls.iter().enumerate() {
                let body = &mut self.world.bodies[handle];
                let mut acceleration = Vector::from_array(self.input.acceleration);
                if let Some(pointer) = self.input.pointer {
                    let delta = body.translation() - Vector::from_array(pointer);
                    let distance = delta.length();
                    if distance > 0.001 && distance < 0.22 {
                        acceleration += delta / distance * (1.0 - distance / 0.22) * 15.0;
                    }
                }
                if self.input.reduced_motion {
                    acceleration *= 0.1;
                }
                // Sphere Cd=.47, air density=1.225 kg/m³. Implicit quadratic
                // drag update stays dissipative even for a fast sensor impulse.
                let radius = SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0;
                let velocity = body.linvel();
                body.set_linvel(
                    velocity * sphere_drag_factor(radius, velocity.length(), body.mass(), dt),
                    false,
                );
                body.reset_forces(false);
                if acceleration.length_squared() > 0.0 {
                    body.add_force(acceleration * body.mass(), true);
                }
            }
            // Resolve fast ceiling compression without changing ordinary free
            // impacts. Force iterations remain bounded at eight; all contacts
            // use eight positional stabilization iterations.
            let roof_contact = self.balls.iter().enumerate().any(|(i, (h, _))| {
                let b = &self.world.bodies[*h];
                b.is_enabled()
                    && self.bars[SURFACE_END_COUNT..]
                        .iter()
                        .any(|(post, collider)| {
                            let post = &self.world.bodies[*post];
                            if !post.is_enabled() {
                                return false;
                            }
                            let (left, right) = chord_points(&self.world.colliders[*collider]);
                            let radius = SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0;
                            (left.x - radius..=right.x + radius).contains(&b.translation().x)
                                && b.translation().y + radius + b.linvel().y.max(0.0) * dt
                                    >= left.y.min(right.y) - CLEARANCE
                        })
            });
            self.world
                .integration_parameters
                .contact_softness
                .natural_frequency = if roof_contact { 240.0 } else { 60.0 };
            self.world.step_with_events(
                &JoinedSurface {
                    bars: &self.bars,
                    velocities: &self.bar_velocities,
                    inv_dt: 1.0 / dt,
                },
                &(),
            );
            let mut supported = [0_u32; 2];
            let mut driven = [0_u32; 2];
            let mut supports = [[0_u32; BALL_COUNT]; 2];
            for (i, &(_, collider)) in self.balls.iter().enumerate() {
                let mut touching = [false; COUNT];
                for pair in self.world.narrow_phase.contact_pairs_with(collider) {
                    let impulse = pair.total_impulse_magnitude();
                    self.snapshot.values[CONTACT_OFFSET + i] += impulse;
                    let other = if pair.collider1 == collider {
                        pair.collider2
                    } else {
                        pair.collider1
                    };
                    let contact_y = pair
                        .manifolds
                        .iter()
                        .map(|m| {
                            m.data.normal.y
                                * if pair.collider2 == collider {
                                    1.0
                                } else {
                                    -1.0
                                }
                        })
                        .fold(0.0_f32, |a, b| if b.abs() > a.abs() { b } else { a });
                    let active = pair.has_any_active_contact();
                    // One tag per source and end, including the wrapped copies.
                    let tag = (self.world.colliders[other].user_data & 0xffff) as usize;
                    for (end, sign) in [1.0, -1.0].iter().enumerate() {
                        if active && contact_y * sign > 0.1 && (1..=BALL_COUNT).contains(&tag) {
                            supports[end][i] |= 1 << (tag - 1);
                        }
                    }
                    if tag > COUNT {
                        let end = (tag - COUNT - 1) / COUNT;
                        let band = (tag - COUNT - 1) % COUNT;
                        // Even a steep pair of joined slopes can support a
                        // sphere. The outer top needs an inward component,
                        // rather than the old rectangular-tip angle cutoff.
                        let inward = active && contact_y * if end == 0 { 1.0 } else { -1.0 } > 0.0;
                        supported[end] |= u32::from(inward) << i;
                        // A joined tip can move because either neighbour rose
                        // or because the profile scrolled. Use its real contact
                        // velocity, independent of the source knot's height.
                        let surface = &self.world.bodies[self.world.colliders[other]
                            .parent()
                            .expect("prescribed surface body")];
                        let moving_inward = pair.manifolds.iter().any(|manifold| {
                            let normal = manifold.data.normal
                                * if pair.collider2 == collider {
                                    1.0
                                } else {
                                    -1.0
                                };
                            manifold.data.solver_contacts.iter().any(|contact| {
                                let flow = if pair.collider1 == other {
                                    contact.tangent_velocity
                                } else {
                                    -contact.tangent_velocity
                                };
                                ramp_contact_velocity(surface, contact.point, flow, dt).dot(normal)
                                    > 0.0
                            })
                        });
                        driven[end] |= u32::from(inward && impulse > 0.0 && moving_inward) << i;
                        // A ramp spans two colour halves. Attribute the physical
                        // contact to the same source band as the visible coating.
                        let Some(contact) = pair
                            .manifolds
                            .iter()
                            .flat_map(|m| m.data.solver_contacts.iter())
                            .next()
                        else {
                            continue;
                        };
                        let (left, right) = chord_points(&self.world.colliders[other]);
                        let piece = (self.world.colliders[other].user_data >> 16) as usize - 1;
                        let j = if !piece.is_multiple_of(2)
                            && contact.point.x > (left.x + right.x) * 0.5
                        {
                            (band + 1) % COUNT
                        } else {
                            band
                        };
                        let onset = active && impulse > 0.0 && !self.touching[i][j] && !touching[j];
                        touching[j] |= active && (self.touching[i][j] || impulse > 0.0);
                        self.snapshot.values[IMPULSE_OFFSET + i * COUNT + j] += impulse;
                        if onset {
                            let mass = self.world.bodies[self.balls[i].0].mass();
                            let blend = contact_pigment_blend(impulse, mass);
                            if blend == 0.0 {
                                continue;
                            }
                            // Pick up the contacted source color, with or without audio.
                            for c in 0..3 {
                                self.colors[i][c] +=
                                    (self.palette[j][c] - self.colors[i][c]) * blend;
                            }
                        }
                    }
                }
                self.touching[i] = touching;
            }
            let release = release_speed(
                self.config.gravity,
                self.hop_height(self.input.reduced_motion),
            );
            for (end, inward) in [1.0, -1.0].iter().enumerate() {
                let previous_driven = self.driven[end]
                    .iter()
                    .enumerate()
                    .fold(0_u32, |mask, (i, &value)| mask | (u32::from(value) << i));
                for _ in 0..BALL_COUNT {
                    let before = (supported[end], driven[end]);
                    for (i, &support) in supports[end].iter().enumerate() {
                        supported[end] |= u32::from(support & before.0 != 0) << i;
                        driven[end] |=
                            u32::from(support & (before.1 | (before.0 & previous_driven)) != 0)
                                << i;
                    }
                    if before == (supported[end], driven[end]) {
                        break;
                    }
                }
                for i in 0..BALL_COUNT {
                    let support = supported[end] & (1 << i) != 0;
                    if self.supported[end][i] && !support && self.driven[end][i] {
                        let body = &mut self.world.bodies[self.balls[i].0];
                        let mut velocity = body.linvel();
                        if velocity.y * inward > release {
                            velocity.y = release * inward;
                            body.set_linvel(velocity, true);
                        }
                    }
                    self.driven[end][i] =
                        support && (driven[end] & (1 << i) != 0 || self.driven[end][i]);
                    self.supported[end][i] = support;
                }
            }
        }
        // Once per fixed tick, regardless of contact substeps or browser FPS.
        for (surface, target) in self
            .pigments
            .as_chunks_mut::<9>()
            .0
            .iter_mut()
            .zip(self.colors)
        {
            advance_pigment(surface, target, DT);
        }
        self.tick += 1;
        self.write_transforms();
    }
    fn resize_depth(&mut self) {
        let depth = self.input.depth;
        if depth == self.config.depth {
            return;
        }
        self.config.depth = depth;
        for (i, handle) in self.depth_walls.iter().enumerate() {
            self.world.bodies[*handle].set_translation(
                Vector::new(0.0, 0.0, if i == 0 { -depth / 2.0 } else { depth / 2.0 }),
                false,
            );
        }
        for (index, &(_, handle)) in self.bars.iter().enumerate() {
            let shape = self.world.colliders[handle]
                .shape()
                .as_shape::<RampPrism>()
                .expect("ramp prism")
                .with_depth(depth);
            self.world.colliders[handle].set_shape(SharedShape::new(shape));
            self.surface_dimensions[index][1] = depth;
        }
        for (i, &(handle, _)) in self.balls.iter().enumerate() {
            let body = &mut self.world.bodies[handle];
            let mut position = body.translation();
            let limit = depth / 2.0 - SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0 - CLEARANCE;
            let z = position.z.clamp(-limit, limit);
            if z != position.z {
                position.z = z;
                body.set_translation(position, true);
                let mut velocity = body.linvel();
                if velocity.z * z > 0.0 {
                    velocity.z = 0.0;
                    body.set_linvel(velocity, true);
                }
            }
        }
    }
    fn resize_ceiling(&mut self) {
        if self.config.height >= self.ceiling_height {
            self.ceiling_height = self.config.height;
        } else {
            let ball_top = self
                .balls
                .iter()
                .enumerate()
                .filter(|(_, (h, _))| self.world.bodies[*h].is_enabled())
                .map(|(i, (h, _))| {
                    self.world.bodies[*h].translation().y
                        + SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0
                        + CLEARANCE
                })
                .fold(0.0_f32, f32::max)
                + self.bar_positions.iter().copied().fold(0.0_f64, f64::max) as f32;
            let bar_top = 2.0 * self.bar_positions.iter().copied().fold(0.0_f64, f64::max) as f32
                + self.config.height
                - 2.0 * self.bar_max();
            self.ceiling_height = self
                .ceiling_height
                .min(self.config.height.max(ball_top).max(bar_top));
        }
        self.world.bodies[self.ceiling]
            .set_translation(Vector::new(0.0, self.ceiling_height, 0.0), false);
    }
    fn write_transforms(&mut self) {
        let bar_max = self.bar_max();
        let hop_height = self.hop_height(self.input.reduced_motion);
        let values = &mut self.snapshot.values;
        values[0] = self.tick as f32 / HZ as f32;
        values[1] = self.config.height;
        values[2] = self.tick as f32;
        values[SCROLL_OFFSET] = (self.scroll_phase % COUNT as f64) as f32;
        values[GEOMETRY_OFFSET..SCROLL_OFFSET].copy_from_slice(&[
            self.ceiling_height,
            bar_max,
            hop_height,
            MIN_HEIGHT,
            self.config.depth,
        ]);
        for (i, &(handle, _)) in self.balls.iter().enumerate() {
            let body = &self.world.bodies[handle];
            let out = &mut values[3 + i * BODY_STRIDE..3 + (i + 1) * BODY_STRIDE];
            out[..3].copy_from_slice(&body.translation().to_array());
            out[3..7].copy_from_slice(&body.rotation().to_array());
            out[7] = SIZE_RATIOS[i] * BALL_SIZE_UNIT / 2.0;
            out[8] = body.mass();
            out[9..12].copy_from_slice(&body.linvel().to_array());
            out[12..15].copy_from_slice(&body.angvel().to_array());
            out[15..18].copy_from_slice(&pigment_color(
                self.pigments[i * 9..i * 9 + 9]
                    .try_into()
                    .expect("fixed pigment surface"),
            ));
        }
        for i in 0..COUNT {
            values[VELOCITY_OFFSET + i] = self.bar_velocities[i] as f32;
            values[BAR_OFFSET + i] = self.bar_positions[i] as f32;
        }
    }
    pub fn snapshot(&self) -> &SimulationSnapshot {
        &self.snapshot
    }
}

/// Small numeric WASM boundary. The world and its interfaces above use no JS types.
#[wasm_bindgen]
pub struct PhysicsSimulation(Simulation);
#[wasm_bindgen]
impl PhysicsSimulation {
    #[wasm_bindgen(constructor)]
    pub fn new(config: &[f32], palette: &[f32]) -> Result<Self, JsError> {
        if palette.len() != COUNT * 3 {
            return Err(JsError::new("Expected 24 colors"));
        }
        let config = SimulationConfig::from_values(config).map_err(JsError::new)?;
        let colors =
            std::array::from_fn(|i| [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]]);
        Simulation::new(config, colors)
            .map(Self)
            .map_err(JsError::new)
    }
    pub fn defaults() -> Vec<f32> {
        SimulationConfig::default().values().to_vec()
    }
    pub fn listening_level(level: f32, band: usize, seconds: f64, reduced: bool) -> f32 {
        musical_lights_core::lights::musical_motion::listening_level(level, band, seconds, reduced)
    }
    pub fn layout() -> Vec<f32> {
        vec![
            COUNT as f32,
            HZ as f32,
            WIDTH,
            PITCH,
            BRIDGE_WIDTH, // straight join width; the surface has no open gap
            0.0,          // joined tips: no rounded trough at the seam
            POST_HEIGHT,
            0.0, // Historical headroom fraction; v2 publishes actual geometry below.
            BODY_STRIDE as f32,
            BAR_OFFSET as f32,
            IMPULSE_OFFSET as f32,
            CONTACT_OFFSET as f32,
            SNAPSHOT_LEN as f32,
            BASELINE,
            VELOCITY_OFFSET as f32,
            COST_OFFSET as f32,
            MAX_SUBSTEPS as f32,
            GEOMETRY_OFFSET as f32,
            18.0, // flat caps with straight joins, continuous contact fill and live depth
            MIN_HEIGHT,
            SCROLL_OFFSET as f32,
            BALL_COUNT as f32,
            INPUT_LEN as f32, // physical inputs followed by each source's audio attack edge
        ]
    }
    pub fn input(&mut self, values: &[f32]) -> Result<(), JsError> {
        // 24 levels, acceleration xyz, pointer active + xyz, reduced, height,
        // scrolling, gravity xyz + active, then 24 audio attack edges and enclosure depth.
        if values.len() != INPUT_LEN
            || values.iter().any(|v| !v.is_finite())
            || ![0.0, 1.0].contains(&values[27])
            || ![0.0, 1.0].contains(&values[31])
            || ![0.0, 1.0].contains(&values[33])
            || ![0.0, 1.0].contains(&values[37])
        {
            return Err(JsError::new(
                "Expected 63 simulation inputs with scrolling, gravity, audio attacks and enclosure depth",
            ));
        }
        let input = SimulationInput {
            tick: self.0.tick,
            levels: std::array::from_fn(|i| values[i]),
            attacks: std::array::from_fn(|i| values[ATTACK_OFFSET + i]),
            acceleration: [values[24], values[25], values[26]],
            gravity: (values[37] == 1.0).then_some([values[34], values[35], values[36]]),
            pointer: (values[27] == 1.0).then_some([values[28], values[29], values[30]]),
            reduced_motion: values[31] == 1.0,
            height: values[32],
            depth: values[DEPTH_INPUT],
            scrolling: values[33] == 1.0,
        };
        self.0.apply(input).map_err(JsError::new)
    }
    pub fn step(&mut self) {
        self.0.step();
    }
    pub fn set_tempo(&mut self, bpm: f32) {
        self.0.set_tempo(bpm);
    }
    pub fn configure_dance(
        &mut self,
        odds: &[f64],
        flight: f32,
        seed: u32,
        scroll_speed: f64,
    ) -> Result<(), JsError> {
        self.0
            .configure_dance(
                odds.try_into()
                    .map_err(|_| JsError::new("Expected five direction settings"))?,
                flight,
                seed,
                scroll_speed,
            )
            .map_err(JsError::new)
    }
    pub fn accent(&mut self, sequence: u32) -> Result<(), JsError> {
        self.0.accent(sequence).map_err(JsError::new)
    }
    pub fn horizontal_direction(&self) -> f64 {
        self.0.dance.direction
    }
    pub fn pigments_ptr(&self) -> *const f32 {
        self.0.pigments.as_ptr()
    }
    pub fn snapshot_ptr(&self) -> *const f32 {
        self.0.snapshot.values.as_ptr()
    }
    pub fn tick(&self) -> f64 {
        self.0.tick as f64
    }
}

#[cfg(test)]
mod tests;
