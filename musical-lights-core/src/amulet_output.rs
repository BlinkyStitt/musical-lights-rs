//! One response pass per candidate, with a common encoded-current limit.
use crate::{
    amulet::{COUNTS, PIXELS},
    lights::LedResponse,
    provisioning::SparkleRecord,
};
use palette::LinSrgb;
use smart_leds::RGB8;
/// Installed, explicitly unmeasured conservative WS2812 RGB current profile:
/// 1 mA idle plus 20 mA per channel at drive 255. Physical verification is separate.
pub fn current_ua(pixels: &[RGB8]) -> u32 {
    pixels
        .iter()
        .map(|p| 1000 + (p.r as u32 + p.g as u32 + p.b as u32) * 20000 / 255)
        .sum()
}
pub fn encode(
    settings: &SparkleRecord,
    profiles: &[LedResponse; 4],
    linear: &[LinSrgb; PIXELS],
    output: &mut [RGB8; PIXELS],
) -> Option<f32> {
    if !settings.valid() {
        output.fill(RGB8::default());
        return None;
    }
    let budgets = [
        settings.circle_ma.get(),
        settings.halo_ma.get(),
        settings.inner_ma.get(),
        settings.outer_ma.get(),
    ];
    if COUNTS.iter().zip(budgets).any(|(n, b)| *n > b as usize) {
        output.fill(RGB8::default());
        return None;
    }
    let caps = [
        settings.circle_cap,
        settings.halo_cap,
        settings.inner_cap,
        settings.outer_cap,
    ];
    let candidate = |scale: f32, out: &mut [RGB8; PIXELS]| {
        let mut offset = 0;
        let mut total = 0;
        let mut valid = true;
        for bank in 0..4 {
            for i in offset..offset + COUNTS[bank] {
                out[i] = profiles[bank].encode(linear[i] * scale, caps[bank]);
            }
            let current = current_ua(&out[offset..offset + COUNTS[bank]]);
            total += current;
            valid &= current <= budgets[bank] as u32 * 1000;
            offset += COUNTS[bank];
        }
        valid
            && total + settings.reserve_ma.get() as u32 * 1000
                <= settings.total_ma.get() as u32 * 1000
    };
    if candidate(1.0, output) {
        return Some(1.0);
    }
    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..12 {
        let middle = (low + high) / 2.0;
        if candidate(middle, output) {
            low = middle;
        } else {
            high = middle;
        }
    }
    candidate(low, output);
    Some(low)
}
