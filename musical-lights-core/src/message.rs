//! todo: theres lots of options for serialization. postcard looks easy to use. benchmark things if it even matters for our use case
/// TODO: support Read and embedded-io::Read and Async variants
use defmt::error;
use defmt::warn;
use postcard::accumulator::CobsAccumulator;
use postcard::accumulator::FeedResult;
// use postcard::de_flavors::{Crc16 as DeCrc16, De as DeCobs};
// TODO: need the crc flavor
// use postcard::ser_flavors::crc::to_slice_u8;
// use postcard::ser_flavors::{Cobs, Slice};
// use postcard::serialize_with_flavor;
use heapless::Vec;
use postcard::de_flavors;
use postcard::experimental::max_size::MaxSize;
use serde::{Deserialize, Serialize};

use crate::compass::Coordinate;
use crate::compass::Magnetometer;
use crate::errors::MyResult;
use crate::gps::GpsTime;
use crate::orientation::Orientation;

/// TODO: peer ids should be a pubkey
#[derive(Debug, Serialize, Deserialize, MaxSize, PartialEq)]
pub struct PeerId(u8);

#[derive(Serialize, Deserialize, Debug, PartialEq, MaxSize)]
pub enum Message {
    GpsTime(GpsTime),
    Magnetometer(Magnetometer),
    Orientation(Orientation),
    /// TODO: should these be batched up?
    PeerCoordinate(PeerId, Coordinate),
    Ping(u8),
    Pong(u8),
    SelfCoordinate(Coordinate),
}

// TODO: keep the buffer in a thread local
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

    Ok(size)
}

/// this drops any extra data, so be careful how you use this!
fn deserialize_with_crc<T>(data: &[u8]) -> MyResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let digest = CRC.digest();

    let message = de_flavors::crc::from_bytes_u16(data, digest)?;

    Ok(message)
}

/// a hopefully durable deserialze.
/// this reverses `serialize_with_crc_and_cobs`.
/// you probbaly want something more like the `example_deserialize_loop`
pub fn deserialize_with_cobs_and_crc<T>(data: &mut [u8]) -> MyResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let size = cobs::decode_in_place(data)?;

    deserialize_with_crc(&data[..size])
}

/*
/// TODO: where does this code belong? how should we handle the items? send them on a channel?
/// TODO: read should be either from std or from embedded-io
/// TODO: What about async io?
/// TODO: RAW_BUF_BYTES needs to be large enough to hold at least one encoded T. i', not sure how to enforce that at compile time
pub fn example_deserialize_loop<const RAW_BUF_BYTES: usize, const COB_BUF_BYTES: usize, R, T>(
    mut input: R,
    outputs: flume::Sender<T>,
) -> eyre::Result<()>
where
    R: Read,
    T: for<'de> Deserialize<'de>,
{
    // TODO: how should we make this work, and what should the asserts be?
    // const _: () = assert!(RAW_BUF_BYTES > 0, "RAW_BUF_BYTES must be greater than 0");
    // const RAW_BUF_BYTES: usize = max_size_with_crc_and_cobs::<T>();
    // const _: () = assert!(RAW_BUF_BYTES * 3 == COB_BUF_BYTES);

    // TODO: what size do these buffers need to be?
    let mut raw_buf = [0u8; RAW_BUF_BYTES];
    let mut cobs_buf = CobsAccumulator::<COB_BUF_BYTES>::new();

    // TODO: buffered read until we get a zero byte. thats the end delimeter for the cobs encoded messages
    while let Ok(ct) = input.read(&mut raw_buf) {
        if ct == 0 {
            // Finished reading input
            break;
        }

        let mut window = &raw_buf[..ct];

        'cobs: while !window.is_empty() {
            // TODO: RAW_BUF_BYTES is probably the wrong size for feed. calculte it from the generic types somehow
            window = match cobs_buf.feed::<Vec<u8, RAW_BUF_BYTES>>(window) {
                FeedResult::Consumed => break 'cobs,
                FeedResult::OverFull(new_wind) => {
                    error!("cobs buffer overfull, dropping data");
                    new_wind
                }
                FeedResult::DeserError(new_wind) => {
                    error!("cobs buffer deserialization error, dropping data");
                    new_wind
                }
                FeedResult::Success { data, remaining } => {
                    match deserialize_with_crc(&data) {
                        Ok(message) => {
                            if let Err(err) = outputs.send(message) {
                                warn!("failed to send message: {}", err);
                            }
                        }
                        Err(err) => {
                            warn!("failed to deserialize message: {}", err);
                        }
                    }

                    remaining
                }
            };
        }
    }
    Ok(())
}
*/

// // TODO: make this optional
// pub async fn example_deserialize_loop_async<
//     const RAW_BUF_BYTES: usize,
//     const COB_BUF_BYTES: usize,
//     // TODO: Read or BufRead?
//     R: embedded_io_async::Read,
//     T,
// >(
//     mut input: R,
//     outputs: flume::Sender<T>,
// ) -> eyre::Result<()>
// where
//     T: for<'de> Deserialize<'de>,
// {
//     // TODO: DRY
// }

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

        let message = Message::Ping(42);

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
