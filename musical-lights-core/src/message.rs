//! todo: theres lots of options for serialization. postcard looks easy to use. benchmark things if it even matters for our use case
// use postcard::de_flavors::{Crc16 as DeCrc16, De as DeCobs};
// TODO: need the crc flavor
// use postcard::ser_flavors::crc::to_slice_u8;
// use postcard::ser_flavors::{Cobs, Slice};
// use postcard::serialize_with_flavor;
use postcard::de_flavors;
use postcard::ser_flavors;
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

/// TODO: i have no idea which algo to pick. theres so many
/// TODO: take this as an argument?
pub const CRC: crc::Crc<u16> = crc::Crc::<u16>::new(&crc::CRC_16_IBM_SDLC);

/// TODO: is writing to a buffer like this good? should we have a std version that returns a Vec?
/// TODO: <https://github.com/jamesmunns/postcard/issues/117#issuecomment-2888769291>
pub fn durable_serialize<T>(message: &T, buf: &mut [u8], output: &mut [u8]) -> eyre::Result<usize>
where
    T: Serialize,
{
    let slice = ser_flavors::Slice::new(buf);

    let digest = CRC.digest();

    // TODO: i thought a cobs_flavor be what we want here, but thats not working
    let crc_flavor = ser_flavors::crc::CrcModifier::new(slice, digest);

    let intermediate = postcard::serialize_with_flavor(message, crc_flavor)?;

    let size = cobs::encode(intermediate, output);

    Ok(size)
}

pub fn durable_deserialize<'a, T>(data: &'a mut [u8]) -> eyre::Result<T>
where
    T: Deserialize<'a>,
{
    // TODO: use the cobs flavor?
    // TODO: decode in place or some other decoder?
    cobs::decode_in_place(data)?;

    let slice = de_flavors::Slice::new(data);

    let digest = CRC.digest();
    let crc_flavor = de_flavors::crc::CrcModifier::new(slice, digest);

    let mut deserializer = postcard::Deserializer::from_flavor(crc_flavor);

    let message = T::deserialize(&mut deserializer)?;

    // TODO: do we care about the remainder? i think that would mean we got some extra bytes! we need to put that into the data buffer, right?

    Ok(message)
}
