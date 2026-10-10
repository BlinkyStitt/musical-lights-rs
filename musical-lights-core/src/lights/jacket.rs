//! Two mirrored 8×32 serpentine panels. No per-row normalization or peak gain.
use super::{Gradient, Layout, LedResponse, SnakeXY};
use crate::audio::visual::{DISPLAY_BANDS, DisplayFrame};
use smart_leds::{
    RGB8,
    colors::{BLACK, SILVER},
};

pub const WIDTH: usize = 8;
pub const ROWS: usize = 32;
pub const PIXELS: usize = WIDTH * ROWS;

pub const fn source_band(row: usize) -> usize {
    assert!(row < ROWS);
    row * DISPLAY_BANDS / ROWS
}

/// The caller retains the existing gamma and 32/255 output cap.
pub fn render(
    frame: &DisplayFrame<DISPLAY_BANDS>,
    palette: &Gradient<ROWS>,
    left: &mut [RGB8; PIXELS],
    right: &mut [RGB8; PIXELS],
) {
    let response = LedResponse::default();
    for row in 0..ROWS {
        let band = source_band(row);
        let length = (frame.levels[band].clamp(0.0, 1.0) * (WIDTH - 1) as f32 + 0.5) as usize;
        let color = response.encode(palette.colors[row], 255);
        for x in 0..WIDTH {
            let pixel = if x == length && x > 0 {
                let edge = frame.edges[band].clamp(0.0, 1.0);
                RGB8::new(
                    (color.r as f32 * (1.0 - edge) + SILVER.r as f32 * edge) as u8,
                    (color.g as f32 * (1.0 - edge) + SILVER.g as f32 * edge) as u8,
                    (color.b as f32 * (1.0 - edge) + SILVER.b as f32 * edge) as u8,
                )
            } else if x <= length {
                color
            } else {
                BLACK
            };
            right[SnakeXY::xy_to_n(x, row, WIDTH)] = pixel;
            left[SnakeXY::xy_to_n(WIDTH - 1 - x, row, WIDTH)] = pixel;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_rows_map_to_canonical_bands_and_mirror_exactly() {
        let palette = Gradient::new_mermaid();
        let frame = DisplayFrame {
            levels: core::array::from_fn(|i| i as f32 / 23.0),
            ..Default::default()
        };
        let mut left = [BLACK; PIXELS];
        let mut right = [BLACK; PIXELS];
        render(&frame, &palette, &mut left, &mut right);
        let mut seen = [false; DISPLAY_BANDS];
        for row in 0..ROWS {
            let band = source_band(row);
            seen[band] = true;
            assert_eq!(band, row * 24 / 32);
            let expected_length = (frame.levels[band] * 7.0 + 0.5) as usize;
            for x in 0..WIDTH {
                let pixel = right[SnakeXY::xy_to_n(x, row, WIDTH)];
                assert_eq!(pixel, left[SnakeXY::xy_to_n(WIDTH - 1 - x, row, WIDTH)]);
                assert_eq!(pixel == BLACK, x > expected_length);
            }
        }
        assert!(seen.into_iter().all(|v| v));
    }
    #[test]
    fn only_shared_acoustic_edges_make_the_tip_white() {
        let palette = Gradient::new_mermaid();
        let mut snapshot = crate::audio::visual::DisplaySnapshot::new(0.0);
        let mut levels = [crate::audio::visual::BandLevel {
            activity: 0.5,
            sones: 0.2,
        }; DISPLAY_BANDS];
        snapshot.push(0.0, levels, false);
        let mut left = [BLACK; PIXELS];
        let mut right = [BLACK; PIXELS];
        render(&snapshot.frame(0.1), &palette, &mut left, &mut right);
        assert_eq!(right[SnakeXY::xy_to_n(4, 0, WIDTH)], SILVER);
        // A gain-only rise after the envelope ends must not create a new edge.
        levels.fill(crate::audio::visual::BandLevel {
            activity: 1.0,
            sones: 0.2,
        });
        snapshot.push(2.0, levels, false);
        render(&snapshot.frame(2.0), &palette, &mut left, &mut right);
        assert_ne!(right[SnakeXY::xy_to_n(7, 0, WIDTH)], SILVER);
    }
}
