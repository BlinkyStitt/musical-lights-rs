//! todo: theres lots of options for serialization. postcard looks easy to use. benchmark things if it even matters for our use case
/// TODO: support Read and embedded-io::Read and Async variants
// use postcard::accumulator::CobsAccumulator;
// use postcard::accumulator::FeedResult;
// use postcard::de_flavors::{Crc16 as DeCrc16, De as DeCobs};
// use postcard::ser_flavors::crc::to_slice_u8;
// use postcard::ser_flavors::{Cobs, Slice};
// use postcard::serialize_with_flavor;
// use heapless::Vec;
use postcard::de_flavors;
use postcard::experimental::max_size::MaxSize;
use serde::{Deserialize, Serialize};

use crate::compass::Coordinate;
use crate::compass::Magnetometer;
use crate::errors::MyResult;
use crate::gps::GpsTime;
use crate::orientation::Orientation;
// use crate::logging::{error, warn};

pub const MESSAGE_BAUD_RATE: u32 = 115_200;

/// TODO: peer ids should be a pubkey
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Debug, Serialize, Deserialize, MaxSize, PartialEq)]
pub struct PeerId(u8);

#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Serialize, Deserialize, Debug, PartialEq, MaxSize)]
pub enum Message {
    GpsTime(GpsTime),
    Magnetometer(Magnetometer),
    Orientation(Orientation),
    /// TODO: should these be batched up? should they be signed by the peer? signing can come later
    PeerCoordinate(PeerId, Coordinate),
    Ping,
    Pong,
    SelfCoordinate(Coordinate),
}

// TODO: where do we get digest from?

pub type CrcWidth = u16;

/// TODO: i have no idea which algo to pick. theres so many
/// TODO: take this as an argument?
pub const CRC: crc::Crc<CrcWidth> = crc::Crc::<CrcWidth>::new(&crc::CRC_16_IBM_SDLC);

/// TODO: what size do these buffers need to be?
/// TODO: is writing to a buffer like this good? should we have a std version that returns a Vec?
/// TODO: <https://github.com/jamesmunns/postcard/issues/117#issuecomment-2888769291>
/// NOTE: this does not include the sentinel value, so be careful with how you send this?
pub fn serialize_with_crc_and_cobs<T>(
    value: &T,
    crc_buf: &mut [u8],
    output: &mut [u8],
) -> MyResult<usize>
where
    T: Serialize,
{
    let digest = CRC.digest();

    let intermediate = postcard::ser_flavors::crc::to_slice_u16(value, crc_buf, digest)?;

    // TODO: use max_encoding_length(source_len) to make sure the buffers are the right size? encode panics if they aren't
    let size = cobs::try_encode(intermediate, output)?;

    // try_encode doesn't include the sentinel byte, so we need to add it manually
    // TODO: is this right?
    output[size] = 0;

    Ok(size + 1)
}

/// this drops any extra data, so be careful how you use this!
pub fn deserialize_with_crc<T>(data: &[u8]) -> postcard::Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let digest = CRC.digest();

    de_flavors::crc::from_bytes_u16(data, digest)
}

/// a hopefully durable deserialze.
/// this reverses `serialize_with_crc_and_cobs`.
/// you probbaly want something more like the `example_deserialize_loop`
pub fn deserialize_with_cobs_and_crc<T>(data: &mut [u8]) -> MyResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let size = cobs::decode_in_place(data)?;

    let message = deserialize_with_crc(&data[..size])?;

    Ok(message)
}

// TODO: make this generic.
pub const fn max_size_with_crc<T: MaxSize>() -> usize {
    T::POSTCARD_MAX_SIZE + size_of::<CrcWidth>()
}

pub const fn max_size_with_crc_and_cobs<T: MaxSize>() -> usize {
    cobs::max_encoding_length(max_size_with_crc::<T>())
}

mod tests {
    use super::*;

    #[test]
    fn test_durable_messages() {
        /// the maximum size of the postcard serialized bytes with a CRC attached.
        const MESSAGE_MAX_SIZE_WITH_CRC: usize = max_size_with_crc::<Message>();
        /// the maximum size of the postcard serialized bytes with a CRC attached and cobs encoded.
        /// TODO: this doesn't include the final 0 sentinel byte.
        const MESSAGE_MAX_SIZE_WITH_CRC_AND_COBS: usize = max_size_with_crc_and_cobs::<Message>();

        // encode the message into output
        // TODO: do we need a buffer? can we use the output as buf?
        let mut buf = [0u8; MESSAGE_MAX_SIZE_WITH_CRC];
        let mut output = [0u8; Message::POSTCARD_MAX_SIZE];

        let message = Message::Orientation(Orientation::TopUp);

        println!("message: {message:?}");

        println!("MESSAGE_MAX_SIZE: {}", Message::POSTCARD_MAX_SIZE);
        println!("MESSAGE_MAX_SIZE_WITH_CRC: {MESSAGE_MAX_SIZE_WITH_CRC}");
        println!("MESSAGE_MAX_SIZE_WITH_CRC_AND_COBS: {MESSAGE_MAX_SIZE_WITH_CRC_AND_COBS}");

        let size = serialize_with_crc_and_cobs(&message, &mut buf, &mut output).unwrap();

        assert!(size > 0);

        let sized_output = &mut output[..size];

        println!("encoded: {sized_output:?}");

        // TODO: don't we need a sentinel byte here?
        let deserialized_message: Message = deserialize_with_cobs_and_crc(sized_output).unwrap();

        assert_eq!(deserialized_message, message);
    }
}
