//! todo: theres lots of options for serialization. postcard looks easy to use. benchmark things if it even matters for our use case
// use postcard::de_flavors::{Crc16 as DeCrc16, De as DeCobs};
// TODO: need the crc flavor
// use postcard::ser_flavors::crc::to_slice_u8;
// use postcard::ser_flavors::{Cobs, Slice};
// use postcard::serialize_with_flavor;
use serde::{Deserialize, Serialize};

// // TODO: rewrite this so we only get one Vec. or maybe have different functions?
// #[cfg(feature = "alloc")]
// use alloc::vec::Vec;
// #[cfg(not(feature = "std"))]
// use heapless::Vec;
// #[cfg(feature = "std")]
// use std::vec::Vec;

#[derive(Serialize, Deserialize, Debug)]
pub enum Message {
    Compass,
    GpsTime,
    Orientation,
    PeerPosition,
    Ping(u8),
    Pong(u8),
    SelfPosition,
}

// TODO: keep the buffer in a thread local
// TODO: where do we get digest from?

/*
pub fn serialize_durable_message<'a, const MAX_FRAME: usize>(
    message: &Message,
    buf: &'a mut [u8; MAX_FRAME],
) -> Result<Vec<u8, MAX_FRAME>, postcard::Error> {
    // TODO: need crc flavor, too
    let flavor = Cobs::try_new(Slice::new(buf))?;

    // let digest = Digest::<'_, MAX_FRAME>;

    // let checksummed = to_slice_u8(message, buf, digest)?;

    // serialize_with_flavor(message, flavor)

    todo!();
}

pub fn deserialize_durable_message(data: &[u8]) -> Result<Message, postcard::Error> {
    // let flavor = DeCrc16::new(DeCobs::new(data));
    // from_flavored_bytes(flavor)

    todo!();
}
 */
