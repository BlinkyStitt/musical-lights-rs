const I24_MAX: f32 = (1 << 23) as f32;

/// TODO: better name. this is for 24-bit audio!
/// TODO: write tests for this. chatgpt just made up nonsense
pub fn parse_i2s_24_bit_to_i32(buf: &[u8]) -> impl Iterator<Item = i32> + '_ {
    buf.chunks_exact(4)
        .map(|chunk| i32::from_le_bytes(chunk.try_into().unwrap()))
}

/// TODO: better name. this is for 24-bit audio!
/// TODO: is there a more efficient way to do this?
pub fn parse_i2s_24_bit_to_f32_array<const N: usize>(buf: &[u8]) -> [f32; N] {
    // TODO: debug assert? compile time assert?
    assert_eq!(buf.len(), N * 4);

    let mut out = [0f32; N];
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        let x = i32::from_le_bytes(chunk.try_into().unwrap());
        out[i] = x as f32 / I24_MAX;
    }

    out
}
