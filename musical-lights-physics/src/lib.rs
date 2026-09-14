//! Fixed-step SI-unit simulation, shared without browser APIs by native tests and WASM.
use rapier3d::prelude::*;
use wasm_bindgen::prelude::*;

pub const COUNT: usize = 24;
pub const HZ: u32 = 120;
pub const DT: f32 = 1.0 / HZ as f32;
pub const WIDTH: f32 = 1.2;
pub const PITCH: f32 = WIDTH / COUNT as f32;
pub const GAP: f32 = 0.002;
pub const CORNER: f32 = 0.012;
pub const POST_HEIGHT: f32 = 20.0;
const WALL_HEIGHT: f32 = 100.0;
const WALL_HALF_THICKNESS: f32 = 0.001;
pub const HEADROOM: f32 = 0.05;
pub const BASELINE: f32 = 0.003;
pub const SIZE_RATIOS: [f32; COUNT] = [
    0.55, 1.4, 2.2, 0.8, 3.1, 1.0, 4.0, 1.8, 0.65, 2.6, 1.2, 3.5, 0.65, 1.0, 1.2, 0.8, 1.4, 0.55,
    0.7, 1.1, 1.6, 0.9, 1.3, 0.6,
];
pub const BODY_STRIDE: usize = 18;
pub const BAR_OFFSET: usize = 3 + COUNT * BODY_STRIDE;
pub const IMPULSE_OFFSET: usize = BAR_OFFSET + COUNT;
pub const CONTACT_OFFSET: usize = IMPULSE_OFFSET + COUNT * COUNT;
pub const SNAPSHOT_LEN: usize = CONTACT_OFFSET + COUNT;

/// Prototype assumptions, not measured material properties. Changes require a new world.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimulationConfig {
    pub height: f32,
    pub gravity: f32,
    pub density: f32,
    pub restitution: f32,
    pub friction: f32,
    pub depth: f32,
    pub rise_speed: f32,
    pub fall_speed: f32,
}
impl Default for SimulationConfig {
    fn default() -> Self {
        Self {
            height: 0.6,
            gravity: 9.81,
            density: 1100.0,
            restitution: 0.85,
            friction: 0.20,
            depth: 0.24,
            rise_speed: 1.0,
            fall_speed: 1.25,
        }
    }
}
impl SimulationConfig {
    pub fn values(self) -> [f32; 8] {
        [
            self.height,
            self.gravity,
            self.density,
            self.restitution,
            self.friction,
            self.depth,
            self.rise_speed,
            self.fall_speed,
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
            rise_speed: v[6],
            fall_speed: v[7],
        };
        if !(0.05..=20.0).contains(&c.height)
            || !(0.0..=30.0).contains(&c.gravity)
            || !(1.0..=20000.0).contains(&c.density)
            || !(0.0..=1.0).contains(&c.restitution)
            || !(0.0..=2.0).contains(&c.friction)
            || !(0.2..=2.0).contains(&c.depth)
            || !(0.01..=5.0).contains(&c.rise_speed)
            || !(0.01..=5.0).contains(&c.fall_speed)
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
    palette: [[f32; 3]; COUNT],
    colors: [[f32; 3]; COUNT],
    touching: [[bool; COUNT]; COUNT],
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
                // Default metre-scale tolerances are larger than our smallest sphere.
                normalized_allowed_linear_error: 0.0002,
                normalized_prediction_distance: 0.002,
                friction_model: FrictionModel::Coulomb,
                ..IntegrationParameters::default()
            },
            ..PhysicsWorld::default()
        };
        // 2 mm enclosure panels. Rapier 0.34 sweeps only when relative travel exceeds
        // the combined collider thickness; thick walls permit deep discrete overlap.
        // These walls extend above every supported camera view. There is no ceiling.
        for (half, position) in [
            (
                Vector::new(
                    WIDTH / 2.0 + 0.1,
                    WALL_HALF_THICKNESS,
                    config.depth / 2.0 + 0.1,
                ),
                Vector::new(WIDTH / 2.0, -WALL_HALF_THICKNESS, 0.0),
            ),
            (
                Vector::new(
                    WALL_HALF_THICKNESS,
                    WALL_HEIGHT / 2.0,
                    config.depth / 2.0 + 0.1,
                ),
                Vector::new(-WALL_HALF_THICKNESS, WALL_HEIGHT / 2.0, 0.0),
            ),
            (
                Vector::new(
                    WALL_HALF_THICKNESS,
                    WALL_HEIGHT / 2.0,
                    config.depth / 2.0 + 0.1,
                ),
                Vector::new(WIDTH + WALL_HALF_THICKNESS, WALL_HEIGHT / 2.0, 0.0),
            ),
            (
                Vector::new(WIDTH / 2.0 + 0.1, WALL_HEIGHT / 2.0, WALL_HALF_THICKNESS),
                Vector::new(
                    WIDTH / 2.0,
                    WALL_HEIGHT / 2.0,
                    -config.depth / 2.0 - WALL_HALF_THICKNESS,
                ),
            ),
            (
                Vector::new(WIDTH / 2.0 + 0.1, WALL_HEIGHT / 2.0, WALL_HALF_THICKNESS),
                Vector::new(
                    WIDTH / 2.0,
                    WALL_HEIGHT / 2.0,
                    config.depth / 2.0 + WALL_HALF_THICKNESS,
                ),
            ),
        ] {
            world.insert(
                RigidBodyBuilder::fixed().translation(position),
                ColliderBuilder::cuboid(half.x, half.y, half.z)
                    .friction(config.friction)
                    .restitution(config.restitution),
            );
        }
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
        let balls = std::array::from_fn(|i| {
            let radius = SIZE_RATIOS[i] * (PITCH - GAP) / 2.0;
            // Separate rows by the largest diameter. No initial overlap at any aspect ratio.
            let x = (i % 6) as f32 * 0.2 + 0.1;
            let y = (i / 6) as f32 * 0.2 + 0.14;
            world.insert(
                RigidBodyBuilder::dynamic()
                    .translation(Vector::new(x, y, 0.0))
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
            touching: [[false; COUNT]; COUNT],
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
            || !(0.05..=20.0).contains(&input.height)
        {
            return Err("Invalid or late simulation input");
        }
        // Resizing changes the physical setup, never ball transforms, velocities or sizes.
        self.config.height = input.height;
        self.input = input;
        Ok(())
    }
    pub fn step(&mut self) {
        for (i, &(handle, _)) in self.bars.iter().enumerate() {
            let body = &mut self.world.bodies[handle];
            let position = body.translation();
            let target = BASELINE
                + self.input.levels[i] * (self.config.height * (1.0 - HEADROOM) - BASELINE);
            let distance = target - (position.y + POST_HEIGHT / 2.0);
            let motion = if self.input.reduced_motion { 0.25 } else { 1.0 };
            let step = distance.clamp(
                -self.config.fall_speed * DT * motion,
                self.config.rise_speed * DT * motion,
            );
            body.set_next_kinematic_translation(position + Vector::Y * step);
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
        self.world.step();
        self.tick += 1;
        self.snapshot.values[IMPULSE_OFFSET..].fill(0.0);
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
                if let Some(j) = self.bars.iter().position(|&(_, bar)| bar == other) {
                    touching[j] =
                        pair.has_any_active_contact() && (self.touching[i][j] || impulse > 0.0);
                    self.snapshot.values[IMPULSE_OFFSET + i * COUNT + j] = impulse;
                    if touching[j] && !self.touching[i][j] && impulse > 0.0 {
                        // Blend only on contact onset. Resting load cannot keep changing color.
                        let mass = self.world.bodies[self.balls[i].0].mass();
                        let blend = (impulse / mass * 0.15).clamp(0.0, 0.5);
                        for c in 0..3 {
                            self.colors[i][c] += (self.palette[j][c] - self.colors[i][c]) * blend;
                        }
                    }
                }
            }
            self.touching[i] = touching;
        }
        self.write_transforms();
    }
    fn write_transforms(&mut self) {
        let values = &mut self.snapshot.values;
        values[0] = self.tick as f32 / HZ as f32;
        values[1] = self.config.height;
        values[2] = self.tick as f32;
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
            values[BAR_OFFSET + i] = self.world.bodies[handle].translation().y + POST_HEIGHT / 2.0;
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
            HEADROOM,
            BODY_STRIDE as f32,
            BAR_OFFSET as f32,
            IMPULSE_OFFSET as f32,
            CONTACT_OFFSET as f32,
            SNAPSHOT_LEN as f32,
            BASELINE,
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
