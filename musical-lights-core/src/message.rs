//! todo: theres lots of options for serialization. postcard looks easy to use. benchmark things if it even matters for our use case
use std::io::Read;

use cobs::max_encoding_length;
use defmt::error;
use postcard::accumulator::CobsAccumulator;
use postcard::accumulator::FeedResult;
// use postcard::de_flavors::{Crc16 as DeCrc16, De as DeCobs};
// TODO: need the crc flavor
// use postcard::ser_flavors::crc::to_slice_u8;
// use postcard::ser_flavors::{Cobs, Slice};
// use postcard::serialize_with_flavor;
use heapless::Vec;
use postcard::de_flavors;
use postcard::ser_flavors;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
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

/// TODO: what size do these buffers need to be?
/// TODO: is writing to a buffer like this good? should we have a std version that returns a Vec?
/// TODO: <https://github.com/jamesmunns/postcard/issues/117#issuecomment-2888769291>
pub fn durable_serialize<T>(message: &T, buf: &mut [u8], output: &mut [u8]) -> eyre::Result<usize>
where
    T: Serialize,
{
    let slice = ser_flavors::Slice::new(buf);

    let digest = CRC.digest();

    // TODO: i thought a cobs_flavor be what we want here, but thats not working. we do cobs as a separate step
    let crc_flavor = ser_flavors::crc::CrcModifier::new(slice, digest);

    let intermediate = postcard::serialize_with_flavor(message, crc_flavor)?;

    // TODO: use max_encoding_length(source_len) to make sure the buffers are the right size? encode panics if they aren't
    let size = cobs::encode(intermediate, output);

    Ok(size)
}

pub fn durable_deserialize<'a, T>(data: &'a mut [u8]) -> eyre::Result<T>
where
    T: Deserialize<'a>,
{
    // TODO: use the cobs flavor somehow?
    // TODO: decode in place or some other decoder?
    // TODO: do the cobs in a seperate function? that might make the deserialize loop easier to write
    let size = cobs::decode_in_place(data)?;

    let slice = de_flavors::Slice::new(&data[..size]);

    let digest = CRC.digest();
    let crc_flavor = de_flavors::crc::CrcModifier::new(slice, digest);

    let mut deserializer = postcard::Deserializer::from_flavor(crc_flavor);

    let message = T::deserialize(&mut deserializer)?;

    // TODO: do we care about the remainder? i think that would mean we got some extra bytes! we need to put that into the data buffer, right?

    Ok(message)
}

// TODO: where does this code belong? how should we handle the items? send them on a channel?
// TODO: read should be either from std or from embedded-io
// TODO: What about async io?
pub fn example_deserialize_loop<
    const RAW_BUF_BYTES: usize,
    const COB_BUF_BYTES: usize,
    R: Read,
    T,
>(
    mut input: R,
    outputs: flume::Sender<T>,
) -> eyre::Result<()>
where
    T: for<'de> Deserialize<'de>,
{
    // const _: = assert!(RAW_BUF_BYTES > 0, "RAW_BUF_BYTES must be greater than 0");

    // TODO: what size do these buffers need to be?
    let mut raw_buf = [0u8; RAW_BUF_BYTES];
    let mut cobs_buf: CobsAccumulator<COB_BUF_BYTES> = CobsAccumulator::new();

    // TODO: is this the cleanest way to read until we get a zero byte?
    while let Ok(ct) = input.read(&mut raw_buf) {
        // Finished reading input
        if ct == 0 {
            break;
        }

        let mut window = &raw_buf[..ct];

        // TODO: `T` here is wrong on feed. the cobs gets some bytes. then the bytes get crc checked. what type should the cobs_buf be handling?
        // TODO: i think the cobs buffer needs to be a heapless::Vec<u8> or something like that. but what size for it?
        // TODO: RAW_BUF_BYTES is probably the wrong size for feed
        'cobs: while !window.is_empty() {
            window = match cobs_buf.feed::<Vec<u8, RAW_BUF_BYTES>>(window) {
                FeedResult::Consumed => break 'cobs,
                FeedResult::OverFull(new_wind) => new_wind,
                FeedResult::DeserError(new_wind) => new_wind,
                FeedResult::Success { data, remaining } => {
                    let slice = de_flavors::Slice::new(&data);

                    let digest = CRC.digest();
                    let crc_flavor = de_flavors::crc::CrcModifier::new(slice, digest);

                    let mut deserializer = postcard::Deserializer::from_flavor(crc_flavor);

                    let message = T::deserialize(&mut deserializer)?;
                    // Do something with the crc verified and deserizlied message here

                    if let Err(err) = outputs.send(message) {
                        error!("failed to send message");
                    }

                    remaining
                }
            };
        }
    }
    Ok(())
}

// TODO: make this optional
pub async fn example_deserialize_loop_async<
    const RAW_BUF_BYTES: usize,
    const COB_BUF_BYTES: usize,
    // TODO: Read or BufRead?
    R: embedded_io_async::Read,
    T,
>(
    mut input: R,
    outputs: flume::Sender<T>,
) -> eyre::Result<()>
where
    T: for<'de> Deserialize<'de>,
{
    // TODO: what size do these buffers need to be?
    let mut raw_buf = [0u8; RAW_BUF_BYTES];
    let mut cobs_buf: CobsAccumulator<COB_BUF_BYTES> = CobsAccumulator::new();

    // TODO: is this the cleanest way to read until we get a zero byte?
    while let Ok(ct) = input.read(&mut raw_buf).await {
        // Finished reading input
        if ct == 0 {
            break;
        }

        let mut window = &raw_buf[..ct];

        // TODO: `T` here is wrong on feed. the cobs gets some bytes. then the bytes get crc checked. what type should the cobs_buf be handling?
        // TODO: i think the cobs buffer needs to be a heapless::Vec<u8> or something like that
        'cobs: while !window.is_empty() {
            window = match cobs_buf.feed::<Vec<u8, RAW_BUF_BYTES>>(window) {
                FeedResult::Consumed => break 'cobs,
                FeedResult::OverFull(new_wind) => new_wind,
                FeedResult::DeserError(new_wind) => new_wind,
                FeedResult::Success { data, remaining } => {
                    let slice = de_flavors::Slice::new(&data);

                    let digest = CRC.digest();
                    let crc_flavor = de_flavors::crc::CrcModifier::new(slice, digest);

                    let mut deserializer = postcard::Deserializer::from_flavor(crc_flavor);

                    let message = T::deserialize(&mut deserializer)?;
                    // Do something with the crc verified and deserizlied message here

                    if let Err(err) = outputs.send_async(message).await {
                        // TODO: log the error?
                        error!("failed to send message");
                    };

                    remaining
                }
            };
        }
    }
    Ok(())
}

mod tests {
    use super::*;

    #[test]
    fn test_durable_messages() {
        // encode the message into output
        // TODO: do we need a buffer? can we use the output as buf?
        let mut buf = [0u8; 64];
        let mut output = [0u8; 64];

        let message = Message::Ping(42);

        println!("message: {message:?}");

        let size = durable_serialize(&message, &mut buf, &mut output).unwrap();

        assert!(size > 0);

        let sized_output = &mut output[..size];

        println!("encoded: {sized_output:?}");

        let deserialized_message: Message = durable_deserialize(sized_output).unwrap();

        assert_eq!(deserialized_message, message);
    }
}
