use i24::i24 as I24;

const I24_MAX: f32 = I24::MAX.to_i32() as f32;

/// TODO: better name. this is for 24-bit audio!
/// TODO: is there a more efficient way to do this?
/// TODO: i think this is wrong. i'm not seeing any negative values come out of this
pub fn parse_i2s_24_bit_to_f32_array<const N: usize>(buf: &[u8], out: &mut [f32; N]) {
    // TODO: debug assert? compile time assert?
    assert_eq!(buf.len(), N * 4);

    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        let x = I24::from_be_bytes(chunk.try_into().expect("chunk should always fit"));
        out[i] = (x.to_i32() as f32 / I24_MAX).clamp(-1.0, 1.0);
    }
}
