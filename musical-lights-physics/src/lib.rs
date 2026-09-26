//! Fixed-step SI-unit simulation, shared without browser APIs by native tests and WASM.
use rapier3d::{na::Unit, prelude::*};
use wasm_bindgen::prelude::*;

pub const COUNT: usize = 24;
pub const HZ: u32 = 120;
pub const DT: f32 = 1.0 / HZ as f32;
pub const WIDTH: f32 = 1.2;
pub const PITCH: f32 = WIDTH / COUNT as f32;
pub const GAP: f32 = 0.002;
pub const CORNER: f32 = 0.012;
pub const POST_HEIGHT: f32 = 20.0;
pub const MAX_SUBSTEPS: usize = 128;
pub const MIN_HEIGHT: f32 = 0.40;
pub const CLEARANCE: f32 = 0.004;
pub const BASELINE: f32 = 0.003;
pub const SIZE_RATIOS: [f32; COUNT] = [
    0.55, 1.4, 2.2, 0.8, 3.1, 1.0, 4.0, 1.8, 0.65, 2.6, 1.2, 3.5, 0.65, 1.0, 1.2, 0.8, 1.4, 0.55,
    0.7, 1.1, 1.6, 0.9, 1.3, 0.6,
];
pub const BODY_STRIDE: usize = 18;
pub const BAR_OFFSET: usize = 3 + COUNT * BODY_STRIDE;
pub const IMPULSE_OFFSET: usize = BAR_OFFSET + COUNT;
pub const CONTACT_OFFSET: usize = IMPULSE_OFFSET + COUNT * COUNT;
pub const VELOCITY_OFFSET: usize = CONTACT_OFFSET + COUNT;
pub const COST_OFFSET: usize = VELOCITY_OFFSET + COUNT;
pub const GEOMETRY_OFFSET: usize = COST_OFFSET + 4;
pub const SNAPSHOT_LEN: usize = GEOMETRY_OFFSET + 4;

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
            density: 1100.0,
            restitution: 0.15,
            friction: 0.20,
            depth: 0.24,
            stroke_seconds: 0.040,
            reduced_stroke_seconds: 0.320,
        }
    }
}
impl SimulationConfig {
    pub fn hop_height(self, reduced: bool) -> f32 {
        (self.height * 0.08).min(0.05) * if reduced { 0.5 } else { 1.0 }
    }
    pub fn bar_max(self) -> f32 {
        // Keep the same geometry in Reduced Motion: only the release energy changes.
        self.height
            - SIZE_RATIOS.iter().copied().fold(0.0_f32, f32::max) * (PITCH - GAP)
            - self.hop_height(false)
            - CLEARANCE
    }
    pub fn motion_limits(self, reduced: bool) -> (f64, f64) {
        let height = f64::from(self.bar_max() - BASELINE);
        let time = f64::from(if reduced {
            self.reduced_stroke_seconds
        } else {
            self.stroke_seconds
        });
        (2.0 * height / time, 4.0 * height / (time * time))
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
            || !(0.04..=2.0).contains(&c.stroke_seconds)
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
    pub acceleration: [f32; 3],
    pub pointer: Option<[f32; 3]>,
    pub reduced_motion: bool,
    pub height: f32,
}
impl Default for SimulationInput {
    fn default() -> Self {
        Self {
            tick: 0,
            levels: [0.0; COUNT],
            acceleration: [0.0; 3],
            pointer: None,
            reduced_motion: false,
            height: SimulationConfig::default().height,
        }
    }
}

/// Packed snapshot: time/height/tick, then 24 bodies (position, quaternion, radius,
/// mass, linear velocity, angular velocity, linear-sRGB), 24 actual bar tops,
/// 24×24 normal bar impulses in N·s, and each ball's total normal contact impulse.
#[derive(Clone, Debug, PartialEq)]
pub struct SimulationSnapshot {
    pub values: [f32; SNAPSHOT_LEN],
}

pub struct Simulation {
    pub config: SimulationConfig,
    pub tick: u64,
    world: PhysicsWorld,
    balls: [(RigidBodyHandle, ColliderHandle); COUNT],
    bars: [(RigidBodyHandle, ColliderHandle); COUNT],
    bar_positions: [f64; COUNT],
    bar_velocities: [f64; COUNT],
    bar_targets: [f64; COUNT],
    bar_motion_scales: [f64; COUNT],
    palette: [[f32; 3]; COUNT],
    colors: [[f32; 3]; COUNT],
    touching: [[bool; COUNT]; COUNT],
    ceiling: RigidBodyHandle,
    ceiling_height: f32,
    supported: [bool; COUNT],
    driven: [bool; COUNT],
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
        for (normal, position) in [
            (Vector::Y, Vector::ZERO),
            (Vector::X, Vector::ZERO),
            (-Vector::X, Vector::new(WIDTH, 0.0, 0.0)),
            (Vector::Z, Vector::new(0.0, 0.0, -config.depth / 2.0)),
            (-Vector::Z, Vector::new(0.0, 0.0, config.depth / 2.0)),
        ] {
            world.insert(
                RigidBodyBuilder::fixed().translation(position),
                ColliderBuilder::halfspace(Unit::new_unchecked(normal))
                    .friction(config.friction)
                    .restitution(config.restitution),
            );
        }
        let (ceiling, _) = world.insert(
            RigidBodyBuilder::fixed().translation(Vector::new(0.0, config.height, 0.0)),
            ColliderBuilder::halfspace(Unit::new_unchecked(-Vector::Y))
                .friction(config.friction)
                .restitution(config.restitution),
        );
        let bars = std::array::from_fn(|i| {
            world.insert(
                RigidBodyBuilder::kinematic_position_based().translation(Vector::new(
                    (i as f32 + 0.5) * PITCH,
                    BASELINE - POST_HEIGHT / 2.0,
                    0.0,
                )),
                // Rapier adds the rounding radius outside the cuboid's half extents.
                ColliderBuilder::round_cuboid(
                    (PITCH - GAP) / 2.0 - CORNER,
                    POST_HEIGHT / 2.0 - CORNER,
                    config.depth / 2.0 - CORNER,
                    CORNER,
                )
                .friction(config.friction)
                .restitution(config.restitution),
            )
        });
        let mut order: [usize; COUNT] = std::array::from_fn(|i| i);
        order.sort_by(|&a, &b| SIZE_RATIOS[b].total_cmp(&SIZE_RATIOS[a]).then(a.cmp(&b)));
        let mut spawn = [Vector::ZERO; COUNT];
        let mut bottom = BASELINE + 0.002;
        for (row_index, row) in order.chunks(6).enumerate() {
            let diameter = SIZE_RATIOS[row[0]] * (PITCH - GAP);
            for (column, &i) in row.iter().enumerate() {
                let radius = SIZE_RATIOS[i] * (PITCH - GAP) / 2.0;
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
            let radius = SIZE_RATIOS[i] * (PITCH - GAP) / 2.0;
            world.insert(
                RigidBodyBuilder::dynamic()
                    .translation(spawn[i])
                    .ccd_enabled(true),
                ColliderBuilder::ball(radius)
                    .density(config.density)
                    .friction(config.friction)
                    .restitution(config.restitution),
            )
        });
        let mut sim = Self {
            config,
            tick: 0,
            world,
            balls,
            bars,
            palette,
            colors: palette,
            bar_positions: [f64::from(BASELINE); COUNT],
            bar_velocities: [0.0; COUNT],
            bar_targets: [f64::from(BASELINE); COUNT],
            bar_motion_scales: [1.0; COUNT],
            touching: [[false; COUNT]; COUNT],
            ceiling,
            ceiling_height: config.height,
            supported: [false; COUNT],
            driven: [false; COUNT],
            input: SimulationInput {
                height: config.height,
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
                .acceleration
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 100.0)
            || input
                .pointer
                .is_some_and(|p| p.iter().any(|v| !v.is_finite()))
            || !input.height.is_finite()
            || !(MIN_HEIGHT..=20.0).contains(&input.height)
        {
            return Err("Invalid or late simulation input");
        }
        // Resizing changes the physical setup, never ball transforms, velocities or sizes.
        self.config.height = input.height;
        self.input = input;
        Ok(())
    }
    pub fn step(&mut self) {
        let (max_speed, acceleration) = self.config.motion_limits(self.input.reduced_motion);
        let targets: [f64; COUNT] = std::array::from_fn(|i| {
            f64::from(BASELINE)
                + f64::from(self.input.levels[i]) * f64::from(self.config.bar_max() - BASELINE)
        });
        let travel = f64::from(self.config.bar_max() - BASELINE);
        for (i, &target) in targets.iter().enumerate() {
            if target != self.bar_targets[i] {
                // A small correction takes the same stroke time as a full rise,
                // with proportionally smaller speed and acceleration. Previously
                // 1% fluctuations used full acceleration and completed in 4 ms.
                // Include existing speed so retargeting never deletes momentum.
                self.bar_motion_scales[i] = ((target - self.bar_positions[i]).abs() / travel)
                    .max(self.bar_velocities[i].abs() / max_speed)
                    .min(1.0);
                self.bar_targets[i] = target;
            }
        }
        let bar_speed = (0..COUNT)
            .map(|i| {
                let speed = self.bar_velocities[i].abs();
                if (targets[i] - self.bar_positions[i]).abs() > 1e-9 {
                    let scale = self.bar_motion_scales[i];
                    speed.max((speed + acceleration * scale * f64::from(DT)).min(max_speed * scale))
                } else {
                    speed
                }
            })
            .fold(0.0_f64, f64::max);
        let ball_speed = self
            .balls
            .iter()
            .filter_map(|&(h, _)| {
                let b = &self.world.bodies[h];
                b.is_enabled().then_some(f64::from(b.linvel().length()))
            })
            .fold(0.0_f64, f64::max);
        let min_radius =
            SIZE_RATIOS.iter().copied().fold(f32::INFINITY, f32::min) * (PITCH - GAP) / 2.0;
        // Bound relative travel, including equal opposing balls and bar contacts.
        // Recompute deterministically each outer tick, never from wall-clock cost.
        let required = (((2.0 * ball_speed + bar_speed + 1.0) * f64::from(DT)
            / f64::from(min_radius * 0.5))
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
        for _ in 0..substeps {
            self.resize_ceiling();
            for (i, &(handle, _)) in self.bars.iter().enumerate() {
                stroke(
                    &mut self.bar_positions[i],
                    &mut self.bar_velocities[i],
                    targets[i],
                    f64::from(dt),
                    max_speed * self.bar_motion_scales[i],
                    acceleration * self.bar_motion_scales[i],
                );
                let body = &mut self.world.bodies[handle];
                let mut position = body.translation();
                position.y = (self.bar_positions[i] - f64::from(POST_HEIGHT / 2.0)) as f32;
                body.set_next_kinematic_translation(position);
            }
            for &(handle, _) in &self.balls {
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
                body.reset_forces(false);
                if acceleration.length_squared() > 0.0 {
                    body.add_force(acceleration * body.mass(), true);
                }
            }
            // Resolve fast ceiling compression without changing ordinary free
            // impacts. Keep eight force-solver iterations; use extra positional
            // stabilization only while a sphere is at/predictively near the roof.
            let roof_contact = self.balls.iter().enumerate().any(|(i, (h, _))| {
                let b = &self.world.bodies[*h];
                b.is_enabled()
                    && b.translation().y
                        + SIZE_RATIOS[i] * (PITCH - GAP) / 2.0
                        + b.linvel().y.max(0.0) * dt
                        >= self.ceiling_height - CLEARANCE
            });
            self.world
                .integration_parameters
                .contact_softness
                .natural_frequency = if roof_contact { 240.0 } else { 60.0 };
            self.world
                .integration_parameters
                .num_internal_stabilization_iterations = if roof_contact { 8 } else { 1 };
            self.world.step();
            let mut supported = [false; COUNT];
            let mut driven = [false; COUNT];
            let mut supports = [[false; COUNT]; COUNT];
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
                    let upward = pair.has_any_active_contact()
                        && pair.manifolds.iter().any(|m| {
                            let sign = if pair.collider2 == collider {
                                1.0
                            } else {
                                -1.0
                            };
                            m.data.normal.y * sign > 0.1
                        });
                    if upward
                        && let Some(j) = self.balls.iter().position(|&(_, ball)| ball == other)
                    {
                        supports[i][j] = true;
                    }
                    if let Some(j) = self.bars.iter().position(|&(_, bar)| bar == other) {
                        supported[i] |= upward;
                        driven[i] |= upward && impulse > 0.0 && self.bar_velocities[j] > 0.0;
                        touching[j] =
                            pair.has_any_active_contact() && (self.touching[i][j] || impulse > 0.0);
                        self.snapshot.values[IMPULSE_OFFSET + i * COUNT + j] += impulse;
                        if touching[j] && !self.touching[i][j] && impulse > 0.0 {
                            // Blend only on contact onset. Resting load cannot keep changing color.
                            let mass = self.world.bodies[self.balls[i].0].mass();
                            let blend = (impulse / mass * 0.15).clamp(0.0, 0.5);
                            for c in 0..3 {
                                self.colors[i][c] +=
                                    (self.palette[j][c] - self.colors[i][c]) * blend;
                            }
                        }
                    }
                }
                self.touching[i] = touching;
            }
            for _ in 0..COUNT {
                let before = (supported, driven);
                for i in 0..COUNT {
                    for j in 0..COUNT {
                        if supports[i][j] {
                            supported[i] |= before.0[j];
                            driven[i] |= before.1[j] || (before.0[j] && self.driven[j]);
                        }
                    }
                }
                if before == (supported, driven) {
                    break;
                }
            }
            let release_speed =
                (2.0 * self.config.gravity * self.config.hop_height(self.input.reduced_motion))
                    .sqrt();
            for i in 0..COUNT {
                // Remove excess launch energy only after bar support ends. Clamping
                // a carried ball would drive its supporting collider through it.
                if self.supported[i] && !supported[i] && self.driven[i] {
                    let body = &mut self.world.bodies[self.balls[i].0];
                    let mut velocity = body.linvel();
                    if velocity.y > release_speed {
                        velocity.y = release_speed;
                        body.set_linvel(velocity, true);
                    }
                }
                self.driven[i] = supported[i] && (driven[i] || self.driven[i]);
            }
            self.supported = supported;
        }
        self.tick += 1;
        self.write_transforms();
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
                        + SIZE_RATIOS[i] * (PITCH - GAP) / 2.0
                        + CLEARANCE
                })
                .fold(0.0_f32, f32::max);
            let bar_top = self.bar_positions.iter().copied().fold(0.0_f64, f64::max) as f32
                + self.config.height
                - self.config.bar_max();
            self.ceiling_height = self
                .ceiling_height
                .min(self.config.height.max(ball_top).max(bar_top));
        }
        self.world.bodies[self.ceiling]
            .set_translation(Vector::new(0.0, self.ceiling_height, 0.0), false);
    }
    fn write_transforms(&mut self) {
        let values = &mut self.snapshot.values;
        values[0] = self.tick as f32 / HZ as f32;
        values[1] = self.config.height;
        values[2] = self.tick as f32;
        values[GEOMETRY_OFFSET..].copy_from_slice(&[
            self.ceiling_height,
            self.config.bar_max(),
            self.config.hop_height(self.input.reduced_motion),
            MIN_HEIGHT,
        ]);
        for (i, &(handle, _)) in self.balls.iter().enumerate() {
            let body = &self.world.bodies[handle];
            let out = &mut values[3 + i * BODY_STRIDE..3 + (i + 1) * BODY_STRIDE];
            out[..3].copy_from_slice(&body.translation().to_array());
            out[3..7].copy_from_slice(&body.rotation().to_array());
            out[7] = SIZE_RATIOS[i] * (PITCH - GAP) / 2.0;
            out[8] = body.mass();
            out[9..12].copy_from_slice(&body.linvel().to_array());
            out[12..15].copy_from_slice(&body.angvel().to_array());
            out[15..18].copy_from_slice(&self.colors[i]);
        }
        for (i, &(handle, _)) in self.bars.iter().enumerate() {
            values[VELOCITY_OFFSET + i] = self.bar_velocities[i] as f32;
            values[BAR_OFFSET + i] = self.world.bodies[handle].translation().y + POST_HEIGHT / 2.0;
        }
    }
    pub fn snapshot(&self) -> &SimulationSnapshot {
        &self.snapshot
    }
}

/// Exact constant-acceleration segments of the shortest rest-to-rest stroke.
/// Retargeting preserves velocity, including the braking segment before reversal.
fn stroke(
    position: &mut f64,
    velocity: &mut f64,
    target: f64,
    mut dt: f64,
    max_speed: f64,
    acceleration: f64,
) {
    for _ in 0..8 {
        if dt <= 1e-12 {
            break;
        }
        let delta = target - *position;
        if delta.abs() < 1e-10 && velocity.abs() < 1e-8 {
            *position = target;
            *velocity = 0.0;
            break;
        }
        let direction = if delta >= 0.0 { 1.0 } else { -1.0 };
        let speed = *velocity * direction;
        let distance = delta.abs();
        let stopping = speed * speed / (2.0 * acceleration);
        let (a, duration) = if speed < -1e-9 || stopping >= distance - 1e-10 && speed > 1e-9 {
            (
                -velocity.signum() * acceleration,
                velocity.abs() / acceleration,
            )
        } else {
            let peak = (acceleration * distance + speed * speed / 2.0)
                .sqrt()
                .min(max_speed);
            if speed < peak - 1e-9 {
                (direction * acceleration, (peak - speed) / acceleration)
            } else if speed > max_speed + 1e-9 {
                (
                    -direction * acceleration,
                    (speed - max_speed) / acceleration,
                )
            } else {
                (0.0, ((distance - stopping) / speed).max(1e-12))
            }
        };
        let elapsed = dt.min(duration);
        *position += *velocity * elapsed + 0.5 * a * elapsed * elapsed;
        *velocity += a * elapsed;
        dt -= elapsed;
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
    pub fn layout() -> Vec<f32> {
        vec![
            COUNT as f32,
            HZ as f32,
            WIDTH,
            PITCH,
            GAP,
            CORNER,
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
            2.0, // closed-enclosure geometry/snapshot version
            MIN_HEIGHT,
        ]
    }
    pub fn input(&mut self, values: &[f32]) -> Result<(), JsError> {
        // 24 levels, 3 acceleration values, pointer active + xyz, reduced, height.
        if values.len() != 33
            || values.iter().any(|v| !v.is_finite())
            || ![0.0, 1.0].contains(&values[27])
            || ![0.0, 1.0].contains(&values[31])
        {
            return Err(JsError::new("Expected 33 simulation inputs"));
        }
        let input = SimulationInput {
            tick: self.0.tick,
            levels: std::array::from_fn(|i| values[i]),
            acceleration: [values[24], values[25], values[26]],
            pointer: (values[27] == 1.0).then_some([values[28], values[29], values[30]]),
            reduced_motion: values[31] == 1.0,
            height: values[32],
        };
        self.0.apply(input).map_err(JsError::new)
    }
    pub fn step(&mut self) {
        self.0.step();
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
