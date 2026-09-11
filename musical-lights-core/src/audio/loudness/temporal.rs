//! Scalar temporal stages from ISO 532-1 / MoSQITo 1.2.1 (Apache-2.0).
use num::Float;

#[derive(Clone)]
pub(super) struct Temporal {
    b: [f64; 6],
    capacitors: [[f64; 2]; 21],
    weighted: [f64; 2],
    poles: [f64; 2],
}

impl Temporal {
    pub fn new() -> Self {
        let (short, long, variable) = (0.005, 0.015, 0.075);
        let dt = 1.0 / 48_000.0;
        let p = (variable + long) / (variable * short);
        let q = 1.0 / (short * variable);
        let root = Float::sqrt(p * p / 4.0 - q);
        let (l1, l2) = (-p / 2.0 + root, -p / 2.0 - root);
        let denominator = variable * (l1 - l2);
        let (e1, e2) = (Float::exp(l1 * dt), Float::exp(l2 * dt));
        Self {
            b: [
                (e1 - e2) / denominator,
                ((variable * l2 + 1.0) * e1 - (variable * l1 + 1.0) * e2) / denominator,
                ((variable * l1 + 1.0) * e1 - (variable * l2 + 1.0) * e2) / denominator,
                (variable * l1 + 1.0) * (variable * l2 + 1.0) * (e1 - e2) / denominator,
                Float::exp(-dt / long),
                Float::exp(-dt / variable),
            ],
            capacitors: [[0.0; 2]; 21],
            weighted: [0.0; 2],
            poles: [Float::exp(-dt / 0.0035), Float::exp(-dt / 0.070)],
        }
    }

    pub fn nonlinear(&mut self, current: &[f64; 21], next: &[f64; 21]) -> [f64; 21] {
        core::array::from_fn(|band| {
            let mut input = current[band];
            let delta = (next[band] - input) / 24.0;
            let mut first = 0.0;
            let b = self.b;
            for step in 0..24 {
                let [last, capacitor] = self.capacitors[band];
                let mut out = input;
                let candidate = if last > capacitor {
                    last * b[2] - capacitor * b[3]
                } else {
                    last * b[4]
                };
                if candidate >= input {
                    out = candidate;
                }
                let mut second = out;
                if input < last && last > capacitor {
                    second = (last * b[0] - capacitor * b[1]).min(out);
                }
                if input >= last && !((input - last).abs() < 1e-5 && out <= capacitor) {
                    second = (capacitor - input) * b[5] + input;
                }
                self.capacitors[band] = [out, second];
                if step == 0 {
                    first = out;
                }
                input += delta;
            }
            first
        })
    }

    pub fn weight(&mut self, current: f64, next: f64) -> f64 {
        let mut input = current;
        let delta = (next - current) / 24.0;
        let mut first = 0.0;
        for step in 0..24 {
            for (state, pole) in self.weighted.iter_mut().zip(self.poles) {
                *state = (1.0 - pole) * input + pole * *state;
            }
            if step == 0 {
                first = 0.47 * self.weighted[0] + 0.53 * self.weighted[1];
            }
            input += delta;
        }
        first
    }
}
