use i24::i24 as I24;

const I24_MAX: f32 = I24::MAX.to_i32() as f32;

/// TODO: better name. this is for 24-bit audio!
/// TODO: is there a more efficient way to do this?
/// TODO: i think this is wrong. i'm not seeing any negative values come out of this
pub fn parse_i2s_24_bit_to_f32_array<const IN: usize, const OUT: usize>(
    input: &[u8; IN],
    output: &mut [f32; OUT],
) {
    // TODO: debug assert? compile time assert?
    assert_eq!(IN, OUT * size_of::<f32>());

    for (chunk, x) in input.chunks_exact(4).zip(output.iter_mut()) {
        *x = I24::from_be_bytes([chunk[1], chunk[2], chunk[3]]).to_i32() as f32 / I24_MAX;

        debug_assert!(*x >= -1.0);
        debug_assert!(*x <= 1.0);
    }
}
