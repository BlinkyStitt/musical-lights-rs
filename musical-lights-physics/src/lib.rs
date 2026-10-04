//! Fixed-step SI-unit simulation, shared without browser APIs by native tests and WASM.
use musical_lights_core::lights::bar_motion::Motion;
use musical_lights_core::lights::dance::{DanceMotion, flight_height, release_speed};
use musical_lights_core::lights::musical_motion::{remember_pigment, sphere_drag_factor};
use rapier3d::{na::Unit, prelude::*};
use wasm_bindgen::prelude::*;

pub const COUNT: usize = 24;
pub const BALL_COUNT: usize = 8;
pub const HZ: u32 = 120;
pub const DT: f32 = 1.0 / HZ as f32;
pub const WIDTH: f32 = 1.2;
pub const PITCH: f32 = WIDTH / COUNT as f32;
pub const GAP: f32 = 0.002;
pub const CORNER: f32 = 0.012;
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
pub const SCROLL_OFFSET: usize = GEOMETRY_OFFSET + 4;
pub const SNAPSHOT_LEN: usize = SCROLL_OFFSET + 1;
pub use musical_lights_core::lights::musical_motion::{
    SCROLL_EASE, SCROLL_PEAK_SPEED, SCROLL_SPEED,
};

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
            depth: 0.24,
            stroke_seconds: 0.040,
            reduced_stroke_seconds: 0.320,
        }
    }
}
impl SimulationConfig {
    pub fn hop_height(self, reduced: bool) -> f32 {
        let diameter = SIZE_RATIOS.iter().copied().fold(0.0_f32, f32::max) * (PITCH - GAP);
        flight_height(self.height - diameter - CLEARANCE, 0.3, reduced)
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
    pub gravity: Option<[f32; 3]>,
    pub pointer: Option<[f32; 3]>,
    pub reduced_motion: bool,
    pub height: f32,
    pub scrolling: bool,
}
impl Default for SimulationInput {
    fn default() -> Self {
        Self {
            tick: 0,
            levels: [0.0; COUNT],
            acceleration: [0.0; 3],
            gravity: None,
            pointer: None,
            reduced_motion: false,
            height: SimulationConfig::default().height,
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
    bars: [(RigidBodyHandle, ColliderHandle); COUNT * 3],
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
    ceiling_bars: bool,
    flip_elapsed: f64,
    palette: [[f32; 3]; COUNT],
    colors: [[f32; 3]; BALL_COUNT],
    pigments: [f32; BALL_COUNT * 9],
    touching: [[bool; COUNT]; BALL_COUNT],
    ceiling: RigidBodyHandle,
    ceiling_height: f32,
    resize_from: f32,
    resize_tick: u32,
    supported: [bool; BALL_COUNT],
    driven: [bool; BALL_COUNT],
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
            // Vertical walls shed tangential load instead of pinning spheres.
            // Keep the floor, ceiling, balls and bars on the configured material.
            let vertical = normal.y == 0.0;
            world.insert(
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
                    ((i % COUNT) as f32 + 0.5) * PITCH + ((i / COUNT + 1) % 3) as f32 * WIDTH
                        - WIDTH,
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
                .user_data((COUNT + 1 + i % COUNT) as u128)
                .friction(config.friction)
                .restitution(config.restitution),
            )
        });
        let mut order: [usize; BALL_COUNT] = std::array::from_fn(|i| i);
        order.sort_by(|&a, &b| SIZE_RATIOS[b].total_cmp(&SIZE_RATIOS[a]).then(a.cmp(&b)));
        let mut spawn = [Vector::ZERO; BALL_COUNT];
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
                    .angular_damping(0.15)
                    .ccd_enabled(true),
                ColliderBuilder::ball(radius)
                    .user_data((i + 1) as u128)
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
            colors: std::array::from_fn(|i| palette[i * COUNT / BALL_COUNT]),
            pigments: std::array::from_fn(|i| palette[(i / 9) * COUNT / BALL_COUNT][i % 3]),
            bar_positions: [f64::from(BASELINE); COUNT],
            bar_velocities: [0.0; COUNT],
            motions: [Motion::default(); COUNT],
            tempo: 120.0,
            scroll_phase: 0.0,
            scroll_speed: 0.0,
            dance: DanceMotion::new(1, 0.1),
            flight_fraction: 0.3,
            flight_target: 0.3,
            accent_sequence: 0,
            ceiling_bars: false,
            flip_elapsed: 0.5,
            touching: [[false; COUNT]; BALL_COUNT],
            ceiling,
            ceiling_height: config.height,
            resize_from: config.height,
            resize_tick: RESIZE_TICKS,
            supported: [false; BALL_COUNT],
            driven: [false; BALL_COUNT],
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
            || input.acceleration.iter().any(|v| !v.is_finite())
            || input
                .gravity
                .is_some_and(|g| g.iter().any(|v| !v.is_finite()))
            || input
                .pointer
                .is_some_and(|p| p.iter().any(|v| !v.is_finite()))
            || !input.height.is_finite()
            || !(MIN_HEIGHT..=20.0).contains(&input.height)
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
        chance: f64,
        flight: f32,
        seed: u32,
    ) -> Result<(), &'static str> {
        if !chance.is_finite()
            || !(0.0..=1.0).contains(&chance)
            || !flight.is_finite()
            || !(0.0..=0.5).contains(&flight)
        {
            return Err("Invalid dance settings");
        }
        if self.tick == 0 {
            self.dance = DanceMotion::new(seed, chance);
        } else {
            self.dance.probability = chance;
        }
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
        let diameter = SIZE_RATIOS.iter().copied().fold(0.0_f32, f32::max) * (PITCH - GAP);
        flight_height(
            self.config.height - diameter - CLEARANCE,
            self.flight_fraction,
            reduced,
        )
    }
    fn bar_max(&self) -> f32 {
        self.config.bar_max() + self.config.hop_height(false) - self.hop_height(false)
    }
    pub fn set_tempo(&mut self, bpm: f32) {
        if bpm.is_finite() {
            self.tempo = f64::from(bpm.clamp(60.0, 200.0));
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
                + if self.flip_elapsed < 0.5 {
                    6.0 * travel
                } else {
                    0.0
                }
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
                let speed = bar_speeds[copy % COUNT];
                let reach_x = f64::from(PITCH / 2.0) + SCROLL_PEAK_SPEED * f64::from(PITCH * DT);
                let top = self.bar_positions[copy % COUNT] + speed * f64::from(DT);
                self.balls
                    .iter()
                    .enumerate()
                    .any(|(i, &(ball, _))| {
                        let body = &self.world.bodies[ball];
                        let radius = f64::from(SIZE_RATIOS[i] * (PITCH - GAP) / 2.0);
                        body.is_enabled()
                            && f64::from((body.translation().x - post.translation().x).abs())
                                <= reach_x + radius + ball_reach
                            && if self.ceiling_bars {
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
            SIZE_RATIOS.iter().copied().fold(f32::INFINITY, f32::min) * (PITCH - GAP) / 2.0;
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
            self.resize_ceiling();
            let distance = self.dance.advance(enabled, self.tempo, f64::from(dt));
            self.scroll_speed = self.dance.speed();
            let desired_ceiling = self.dance.ceiling;
            if desired_ceiling != self.ceiling_bars && self.flip_elapsed >= 0.5 {
                self.flip_elapsed = 0.0;
            }
            let before_flip = self.flip_elapsed;
            self.flip_elapsed = (self.flip_elapsed + f64::from(dt)).min(0.5);
            let switched = before_flip < 0.25 && self.flip_elapsed >= 0.25;
            if switched {
                self.ceiling_bars = desired_ceiling;
                self.supported.fill(false);
                self.driven.fill(false);
            }
            let t = ((self.flip_elapsed - 0.25).abs() / 0.25).clamp(0.0, 1.0);
            let gate = t * t * (3.0 - 2.0 * t);
            self.scroll_phase = (self.scroll_phase + distance).rem_euclid((COUNT * 3) as f64);
            let scale = old_travel + (travel - old_travel) * (substep + 1) as f64 / substeps as f64;
            for i in 0..COUNT {
                self.motions[i].advance(f64::from(dt));
                let next = f64::from(BASELINE) + self.motions[i].state.position * scale * gate;
                self.bar_velocities[i] = (next - self.bar_positions[i]) / f64::from(dt);
                self.bar_positions[i] = next;
            }
            for (copy, &(handle, _)) in self.bars.iter().enumerate() {
                let i = copy % COUNT;
                let x = ((i as f64
                    + 0.5
                    + self.scroll_phase
                    + (copy / COUNT + 1) as f64 * COUNT as f64)
                    .rem_euclid((COUNT * 3) as f64)
                    - COUNT as f64)
                    * f64::from(PITCH);
                let body = &mut self.world.bodies[handle];
                let position = Vector::new(
                    x as f32,
                    if self.ceiling_bars {
                        self.ceiling_height - self.bar_positions[i] as f32 + POST_HEIGHT / 2.0
                    } else {
                        (self.bar_positions[i] - f64::from(POST_HEIGHT / 2.0)) as f32
                    },
                    0.0,
                );
                // The other two copies are bookkeeping, not active physics.
                // Enable a full pitch before reaching the enclosure so contact
                // prediction is ready before any part of the post crosses a wall.
                let active = (-PITCH..=WIDTH + PITCH).contains(&position.x);
                if switched
                    || !body.is_enabled()
                    || !active
                    || (body.translation().x - position.x).abs() > WIDTH
                {
                    // Recycling and activation happen outside the closed enclosure.
                    // Never sweep a recycled collider through the balls.
                    body.set_translation(position, false);
                }
                body.set_enabled(active);
                body.set_next_kinematic_translation(position);
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
                let radius = SIZE_RATIOS[i] * (PITCH - GAP) / 2.0;
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
            let mut supported = 0_u32;
            let mut driven = 0_u32;
            let mut supports = [0_u32; BALL_COUNT];
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
                            m.data.normal.y * sign * if self.ceiling_bars { -1.0 } else { 1.0 }
                                > 0.1
                        });
                    // Collider tags identify the source directly, including wrapped
                    // copies. Walls use zero, balls 1..=BALL_COUNT, bars COUNT+1..=2*COUNT.
                    let tag = self.world.colliders[other].user_data as usize;
                    if upward && (1..=BALL_COUNT).contains(&tag) {
                        supports[i] |= 1 << (tag - 1);
                    }
                    if tag > COUNT {
                        let j = tag - COUNT - 1;
                        supported |= u32::from(upward) << i;
                        driven |=
                            u32::from(upward && impulse > 0.0 && self.bar_velocities[j] > 0.0) << i;
                        touching[j] =
                            pair.has_any_active_contact() && (self.touching[i][j] || impulse > 0.0);
                        self.snapshot.values[IMPULSE_OFFSET + i * COUNT + j] += impulse;
                        if touching[j] && !self.touching[i][j] && impulse > 0.0 {
                            // Blend only on contact onset. Resting load cannot keep changing color.
                            let start = i * 9;
                            remember_pigment(
                                (&mut self.pigments[start..start + 9])
                                    .try_into()
                                    .expect("fixed pigment history"),
                                self.palette[j],
                            );
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
            let previous_driven = self
                .driven
                .iter()
                .enumerate()
                .fold(0_u32, |mask, (i, &value)| mask | (u32::from(value) << i));
            for _ in 0..BALL_COUNT {
                let before = (supported, driven);
                for (i, &support) in supports.iter().enumerate() {
                    supported |= u32::from(support & before.0 != 0) << i;
                    driven |=
                        u32::from(support & (before.1 | (before.0 & previous_driven)) != 0) << i;
                }
                if before == (supported, driven) {
                    break;
                }
            }
            let supported: [bool; BALL_COUNT] = std::array::from_fn(|i| supported & (1 << i) != 0);
            let driven: [bool; BALL_COUNT] = std::array::from_fn(|i| driven & (1 << i) != 0);
            let release_speed = release_speed(
                self.config.gravity,
                self.hop_height(self.input.reduced_motion),
            );
            let outward = if self.ceiling_bars { -1.0 } else { 1.0 };
            for i in 0..BALL_COUNT {
                // Remove excess launch energy only after bar support ends. Clamping
                // a carried ball would drive its supporting collider through it.
                if self.supported[i] && !supported[i] && self.driven[i] {
                    let body = &mut self.world.bodies[self.balls[i].0];
                    let mut velocity = body.linvel();
                    if velocity.y * outward > release_speed {
                        velocity.y = release_speed * outward;
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
                - self.bar_max();
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
            8.0, // acoustic-peak direction policy, flight budget, separate SI sensor input
            MIN_HEIGHT,
            SCROLL_OFFSET as f32,
            BALL_COUNT as f32,
            38.0, // input length including gravity xyz and its enabled flag
        ]
    }
    pub fn input(&mut self, values: &[f32]) -> Result<(), JsError> {
        // 24 levels, acceleration xyz, pointer active + xyz, reduced, height, scrolling, gravity xyz + active.
        if values.len() != 38
            || values.iter().any(|v| !v.is_finite())
            || ![0.0, 1.0].contains(&values[27])
            || ![0.0, 1.0].contains(&values[31])
            || ![0.0, 1.0].contains(&values[33])
            || ![0.0, 1.0].contains(&values[37])
        {
            return Err(JsError::new(
                "Expected 38 simulation inputs with scrolling and gravity enablement",
            ));
        }
        let input = SimulationInput {
            tick: self.0.tick,
            levels: std::array::from_fn(|i| values[i]),
            acceleration: [values[24], values[25], values[26]],
            gravity: (values[37] == 1.0).then_some([values[34], values[35], values[36]]),
            pointer: (values[27] == 1.0).then_some([values[28], values[29], values[30]]),
            reduced_motion: values[31] == 1.0,
            height: values[32],
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
    pub fn configure_dance(&mut self, chance: f64, flight: f32, seed: u32) -> Result<(), JsError> {
        self.0
            .configure_dance(chance, flight, seed)
            .map_err(JsError::new)
    }
    pub fn accent(&mut self, sequence: u32) -> Result<(), JsError> {
        self.0.accent(sequence).map_err(JsError::new)
    }
    pub fn ceiling_bars(&self) -> bool {
        self.0.ceiling_bars
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
