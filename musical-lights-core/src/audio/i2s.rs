use i24::i24 as I24;

use crate::remap;

const I24_MAX: f32 = I24::MAX.to_i32() as f32;

/// TODO: better name. this is for 24-bit audio!
/// TODO: is there a more efficient way to do this?
/// TODO: this needs some tests!
pub fn parse_i2s_24_bit_mono_to_f32_array<const IN: usize, const OUT: usize>(
    input: &[u8; IN],
    output: &mut [f32; OUT],
) {
    // TODO: debug assert? compile time assert? should this be size_of i32 or f32?
    assert_eq!(IN, OUT * size_of::<i32>());

    // TODO: should chunk size be 4 or 8? i'm not sure how mono works
    for (chunk, x) in input.chunks_exact(4).zip(output.iter_mut()) {
        // chunk[0] is always empty. TODO: i thought chunk3 was the one that would always be empty, but i guess not?
        debug_assert!(chunk[0] == 0);

        // TODO: be or le?
        *x = I24::from_le_bytes([chunk[1], chunk[2], chunk[3]]).to_i32() as f32 / I24_MAX;

        debug_assert!(*x >= -1.0);
        debug_assert!(*x <= 1.0);
    }
}

/// TODO: this needs some tests!
/// I don't really want to turn everything into f32s, but thats what microfft wants. maybe we should find a library that can work on i16 and i24
pub fn parse_i2s_16_bit_mono_to_f32_array<const IN: usize, const OUT: usize>(
    input: &[u8; IN],
    output: &mut [f32; OUT],
) {
    // TODO: debug assert? compile time assert?
    assert_eq!(IN, OUT * size_of::<i16>());

    // TODO: should chunk size be 2 or 4? i'm not sure how mono works
    for (chunk, x) in input.chunks_exact(2).zip(output.iter_mut()) {
        // TODO: is there an off-by-one error here? does a or b need to be moved by 1?
        *x = remap(
            // TODO: be or le?
            i16::from_le_bytes([chunk[0], chunk[1]]) as f32,
            i16::MIN as f32,
            i16::MAX as f32,
            -1.0,
            1.0,
        );

        debug_assert!(*x >= -1.0);
        debug_assert!(*x <= 1.0);
    }
}

#[cfg(test)]
mod tests {
    // TODO: test for 24-bit audio
    // TODO: test for 16-bit audio
    // TODO: test for 8-bit audio?
}
