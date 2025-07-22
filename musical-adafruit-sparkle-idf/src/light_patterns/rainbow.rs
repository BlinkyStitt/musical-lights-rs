use smart_leds::{
    hsv::{hsv2rgb, Hsv},
    RGB8,
};

/// Fill `light_data` with a full 0..255 hue cycle, repeating each hue `repeat` times.
pub fn rainbow(base_hsv: Hsv, light_data: &mut [RGB8], repeat: usize) {
    let len = light_data.len();
    if len == 0 {
        return;
    }

    // clamp repeat to [1..len]
    let repeat = repeat.clamp(1, len);
    // how many hue‐steps (groups) we need (ceil)
    let groups = len.div_ceil(repeat);
    let last = groups - 1;

    let base_hue = base_hsv.hue;
    let sat = base_hsv.sat;
    let val = base_hsv.val;

    for (i, px) in light_data.iter_mut().enumerate() {
        let group = (i / repeat).min(last);
        // spread 0..255 evenly over `groups`
        let hue_off = ((group as u32 * 255) / last as u32) as u8;
        let hsv = Hsv {
            hue: base_hue.wrapping_add(hue_off),
            sat,
            val,
        };
        *px = hsv2rgb(hsv);
    }
}
