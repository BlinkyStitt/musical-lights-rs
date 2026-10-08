//! Smooth attacks and gravity-limited releases in normalized bar coordinates.
use num::Float;

const FALL_GRAVITY: f64 = 2.0; // bar heights / second²
const FALL_SPEED: f64 = 1.2; // terminal bar heights / second
#[derive(Clone, Copy, Debug, Default)]
pub struct State {
    pub position: f64,
    pub velocity: f64,
    pub acceleration: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct Segment {
    coefficients: [f64; 6],
    duration: f64,
}
impl Segment {
    fn new(from: State, to: State, duration: f64) -> Self {
        let p = to.position - from.position;
        let v = from.velocity * duration;
        let a = from.acceleration * duration * duration;
        let w = to.velocity * duration;
        let b = to.acceleration * duration * duration;
        Self {
            duration,
            coefficients: [
                from.position,
                v,
                a / 2.0,
                10.0 * p - 6.0 * v - 4.0 * w - 1.5 * a + 0.5 * b,
                -15.0 * p + 8.0 * v + 7.0 * w + 1.5 * a - b,
                6.0 * p - 3.0 * v - 3.0 * w - 0.5 * a + 0.5 * b,
            ],
        }
    }
    fn sample(self, time: f64) -> State {
        let t = (time / self.duration).clamp(0.0, 1.0);
        let c = self.coefficients;
        State {
            position: c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5])))),
            velocity: (c[1]
                + t * (2.0 * c[2] + t * (3.0 * c[3] + t * (4.0 * c[4] + t * 5.0 * c[5]))))
                / self.duration,
            acceleration: (2.0 * c[2] + t * (6.0 * c[3] + t * (12.0 * c[4] + t * 20.0 * c[5])))
                / Float::powi(self.duration, 2),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Motion {
    pub state: State,
    pub target: f64,
    segments: [Segment; 3],
    elapsed: f64,
    duration: f64,
    reduced: bool,
    falling: bool,
    fall_start: State,
    brake_duration: f64,
}
impl Motion {
    pub fn retarget(&mut self, target: f64, fast: f64, reduced: bool, slow: f64) {
        if target == self.target && reduced == self.reduced {
            return;
        }
        self.target = target;
        self.reduced = reduced;
        let mut start = self.state;
        let delta = target - start.position;
        self.falling = delta < 0.0;
        if self.falling {
            // Lower targets change only the floor. Preserve downward momentum;
            // an upward attack first brakes before gravity takes over.
            self.brake_duration = if start.velocity > 0.0 {
                if reduced { 0.080 } else { 0.020 }
            } else {
                0.0
            };
            if self.brake_duration > 0.0 {
                let t = self.brake_duration;
                let stop = State {
                    position: start.position
                        + start.velocity * t / 2.0
                        + start.acceleration * t * t / 12.0,
                    ..State::default()
                };
                self.segments[0] = Segment::new(start, stop, t);
                start = stop;
            }
            self.fall_start = start;
            self.elapsed = 0.0;
            return;
        }
        let duration = if reduced {
            slow.max(0.320)
        } else {
            // Quiet attacks must not pay a 140 ms delay. The configured stroke
            // time applies to every rise; retain C2 joins and gravity releases.
            fast
        };
        let brake = if start.velocity * delta < 0.0
            || start.velocity.abs() * duration * 0.5 > delta.abs()
        {
            if reduced { 0.080 } else { 0.020 }
        } else {
            0.0
        };
        self.segments = [Segment::default(); 3];
        if brake > 0.0 {
            // Integral of the cubic Hermite velocity with zero final velocity/acceleration.
            let stop = State {
                position: start.position
                    + start.velocity * brake / 2.0
                    + start.acceleration * brake * brake / 12.0,
                ..State::default()
            };
            self.segments[0] = Segment::new(start, stop, brake);
            start = stop;
        }
        let distance = target - start.position;
        let peak = State {
            position: start.position + 0.7 * distance,
            velocity: 2.0 * distance / duration,
            acceleration: 0.0,
        };
        self.segments[1] = Segment::new(start, peak, duration * 0.7);
        self.segments[2] = Segment::new(
            peak,
            State {
                position: target,
                ..State::default()
            },
            duration * 0.3,
        );
        self.elapsed = 0.0;
        self.duration = brake + duration;
    }
    pub fn sample(&self, after: f64) -> State {
        let mut time = self.elapsed + after;
        if self.falling {
            if time < self.brake_duration {
                return self.segments[0].sample(time);
            }
            time -= self.brake_duration;
            let scale = if self.reduced { 0.25 } else { 1.0 };
            let gravity = FALL_GRAVITY * scale;
            let terminal = FALL_SPEED * Float::sqrt(scale);
            let speed = (-self.fall_start.velocity).clamp(0.0, terminal);
            let accelerating = time.min((terminal - speed) / gravity);
            let distance = speed * accelerating
                + gravity * accelerating * accelerating / 2.0
                + terminal * (time - accelerating);
            let position = self.fall_start.position - distance;
            if position <= self.target {
                return State {
                    position: self.target,
                    ..State::default()
                };
            }
            return State {
                position,
                velocity: -(speed + gravity * accelerating),
                acceleration: if time < (terminal - speed) / gravity {
                    -gravity
                } else {
                    0.0
                },
            };
        }
        if time >= self.duration {
            return State {
                position: self.target,
                ..State::default()
            };
        }
        for segment in self.segments {
            if segment.duration > 0.0 && time < segment.duration {
                return segment.sample(time);
            }
            time -= segment.duration;
        }
        State {
            position: self.target,
            ..State::default()
        }
    }
    pub fn advance(&mut self, dt: f64) {
        self.state = self.sample(dt);
        self.elapsed += dt;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quiet_and_full_attacks_use_the_same_configured_stroke() {
        for height in [0.005, 0.03, 0.08, 0.5, 1.0] {
            let mut motion = Motion::default();
            motion.retarget(height, 0.040, false, 0.320);
            assert!(motion.sample(0.025).position > height * 0.5);
            assert!(motion.sample(0.035).position > height * 0.9);
            motion.advance(0.040);
            assert_eq!(motion.state.position, height);
            assert_eq!(motion.state.velocity, 0.0);
        }
    }
    #[test]
    fn spline_joins_are_continuous_and_retarget_preserves_all_derivatives() {
        let mut motion = Motion::default();
        motion.retarget(1.0, 0.040, false, 0.320);
        let before = motion.sample(0.028 - 1e-9);
        let after = motion.sample(0.028 + 1e-9);
        assert!((before.position - after.position).abs() < 1e-6);
        assert!((before.velocity - after.velocity).abs() < 1e-4);
        assert!((before.acceleration - after.acceleration).abs() < 0.01);
        motion.advance(0.020);
        let state = motion.state;
        motion.retarget(0.0, 0.040, false, 0.320);
        let now = motion.sample(0.0);
        assert_eq!(now.position, state.position);
        assert_eq!(now.velocity, state.velocity);
        assert!((now.acceleration - state.acceleration).abs() < 1e-9);
        motion.advance(0.008);
        assert!(motion.state.velocity > 0.0);
        motion.advance(1.5);
        assert_eq!(motion.state.position, 0.0);
        assert_eq!(motion.state.velocity, 0.0);
        assert_eq!(motion.state.acceleration, 0.0);
    }
    #[test]
    fn identical_packets_do_not_restart_and_resize_does_not_enter_the_controller() {
        let mut motion = Motion::default();
        for _ in 0..18 {
            motion.retarget(0.005, 0.040, false, 0.320);
            motion.advance(1.0 / 120.0);
        }
        assert_eq!(motion.state.position, 0.005);
        assert_eq!(motion.state.velocity, 0.0);
    }
    #[test]
    fn noise_travel_and_speed_are_lower_than_the_previous_controller() {
        let mut motion = Motion {
            state: State {
                position: 0.4,
                ..State::default()
            },
            target: 0.4,
            ..Motion::default()
        };
        let (mut old, mut velocity, mut old_target, mut scale) =
            (0.4_f64, 0.0_f64, 0.4_f64, 1.0_f64);
        let (mut travel, mut old_travel, mut peak, mut old_peak) =
            (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
        for tick in 0..1200 {
            let target = 0.4 + 0.005 * (tick as f64 / 120.0 * 8.0 * std::f64::consts::TAU).sin();
            let previous = motion.state.position;
            motion.retarget(target, 0.040, false, 0.320);
            motion.advance(1.0 / 120.0);
            travel += (motion.state.position - previous).abs();
            peak = peak.max(motion.state.velocity.abs());
            if target != old_target {
                scale = (target - old).abs().max(velocity.abs() / 50.0).min(1.0);
                old_target = target;
            }
            let previous = old;
            stroke(
                &mut old,
                &mut velocity,
                target,
                1.0 / 120.0,
                50.0 * scale,
                2500.0 * scale,
            );
            old_travel += (old - previous).abs();
            old_peak = old_peak.max(velocity.abs());
        }
        eprintln!("noise travel: {old_travel} -> {travel}; peak speed: {old_peak} -> {peak}");
        assert!(travel < old_travel);
        assert!(peak < old_peak);
        // Slow sustained swells still arrive at the true final level.
        for tick in 0..240 {
            motion.retarget(0.4 + 0.2 * tick as f64 / 239.0, 0.040, false, 0.320);
            motion.advance(1.0 / 120.0);
        }
        motion.advance(0.150);
        assert!((motion.state.position - 0.6).abs() < 1e-12);
    }
    #[test]
    fn gravity_drop_has_a_fixed_rate_and_stops_at_the_live_floor() {
        let mut motion = Motion::default();
        motion.retarget(1.0, 0.040, false, 0.320);
        motion.advance(0.05);
        motion.retarget(0.2, 0.040, false, 0.320);
        motion.advance(0.1);
        assert!((motion.state.position - 0.99).abs() < 1e-12);
        assert!((motion.state.velocity + 0.2).abs() < 1e-12);
        // A lower floor does not restart the fall or change its acceleration.
        motion.retarget(0.0, 0.040, false, 0.320);
        motion.advance(0.1);
        assert!((motion.state.position - 0.96).abs() < 1e-12);
        assert!((motion.state.velocity + 0.4).abs() < 1e-12);
        // Raising the floor while still below the bar stops precisely there.
        motion.retarget(0.9, 0.040, false, 0.320);
        for _ in 0..120 {
            motion.retarget(0.9, 0.040, false, 0.320);
            motion.advance(1.0 / 120.0);
            assert!(motion.state.position >= 0.9);
            assert!(motion.state.velocity >= -1.2);
        }
        assert_eq!(motion.state.position, 0.9);
        assert_eq!(motion.state.velocity, 0.0);
        motion.retarget(1.0, 0.040, false, 0.320);
        motion.advance(0.15);
        assert_eq!(motion.state.position, 1.0);
    }
    #[test]
    fn reduced_motion_slows_gravity_and_drops_ignore_sampling_rate() {
        let run = |fps: u32, reduced| {
            let mut motion = Motion::default();
            motion.retarget(1.0, 0.040, reduced, 0.320);
            motion.advance(0.4);
            motion.retarget(0.0, 0.040, reduced, 0.320);
            for _ in 0..fps / 2 {
                motion.advance(1.0 / f64::from(fps));
            }
            motion.state.position
        };
        for fps in [30, 60, 120] {
            assert!((run(fps, false) - 0.75).abs() < 1e-12);
            assert!((run(fps, true) - 0.9375).abs() < 1e-12);
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
}
