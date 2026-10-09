//! Bounded, allocation-free UART frames: Postcard Message, CRC-16/IBM-SDLC
//! (little endian), COBS, then a zero delimiter. No vector length prefix.
use postcard::experimental::max_size::MaxSize;
use serde::{Deserialize, Serialize};

use crate::compass::Coordinate;
use crate::compass::Magnetometer;
use crate::errors::{MyError, MyResult};
use crate::gps::GpsTime;
use crate::orientation::Orientation;

pub const MESSAGE_BAUD_RATE: u32 = 115_200;

/// TODO: peer ids should be a pubkey
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Copy, Clone, Debug, Serialize, Deserialize, Eq, Hash, MaxSize, PartialEq)]
pub struct PeerId(u8);

/// TODO: Message type for setting the next pattern?
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[derive(Copy, Clone, Serialize, Deserialize, Debug, PartialEq, MaxSize)]
pub enum Message {
    GpsTime(GpsTime),
    Orientation(Orientation),
    Magnetometer(Magnetometer),
    /// TODO: should these be batched up? should they be signed by the peer? signing can come later
    PeerCoordinate(PeerId, Coordinate),
    Ping,
    Pong,
    SelfCoordinate(Coordinate),
}

const CRC: crc::Crc<u16> = crc::Crc::<u16>::new(&crc::CRC_16_IBM_SDLC);
const RAW_SIZE: usize = Message::POSTCARD_MAX_SIZE + size_of::<u16>();
const ENCODED_SIZE: usize = cobs::max_encoding_length(RAW_SIZE);

/// Owns the scratch and output buffers for one complete UART frame.
/// Reuse this encoder; the returned frame remains valid until the next encode.
#[derive(Default)]
pub struct MessageEncoder {
    scratch: [u8; RAW_SIZE],
    output: [u8; ENCODED_SIZE + 1],
}

impl MessageEncoder {
    /// Maximum complete wire frame length, including its zero delimiter.
    pub const MAX_FRAME_SIZE: usize = ENCODED_SIZE + 1;

    pub const fn new() -> Self {
        Self {
            scratch: [0; RAW_SIZE],
            output: [0; ENCODED_SIZE + 1],
        }
    }

    /// Serialize exactly one message with CRC, COBS and a final zero delimiter.
    pub fn encode(&mut self, message: &Message) -> MyResult<&[u8]> {
        let raw =
            postcard::ser_flavors::crc::to_slice_u16(message, &mut self.scratch, CRC.digest())?;
        let size = cobs::try_encode(raw, &mut self.output[..ENCODED_SIZE])?;
        self.output[size] = 0;
        Ok(&self.output[..size + 1])
    }
}

/// Owns receive state across arbitrary UART reads. Emits at most one result per
/// delimiter. Empty delimiters are ignored. Oversized frames discard all bytes
/// through their delimiter; malformed frames cannot contaminate the next frame.
#[derive(Default)]
pub struct MessageDecoder {
    buffer: [u8; ENCODED_SIZE],
    length: usize,
    discarding: bool,
}

impl MessageDecoder {
    pub const fn new() -> Self {
        Self {
            buffer: [0; ENCODED_SIZE],
            length: 0,
            discarding: false,
        }
    }

    pub fn feed(&mut self, byte: u8) -> Option<MyResult<Message>> {
        if byte == 0 {
            let length = self.length;
            self.length = 0;
            if self.discarding {
                self.discarding = false;
                return Some(Err(MyError::MessageTooLong));
            }
            if length == 0 {
                return None;
            }
            return Some(self.decode_frame(length));
        }
        if !self.discarding {
            if let Some(slot) = self.buffer.get_mut(self.length) {
                *slot = byte;
                self.length += 1;
            } else {
                self.discarding = true;
            }
        }
        None
    }

    fn decode_frame(&mut self, length: usize) -> MyResult<Message> {
        let size = cobs::decode_in_place(&mut self.buffer[..length])?;
        let payload_size = size
            .checked_sub(size_of::<u16>())
            .ok_or(postcard::Error::DeserializeUnexpectedEnd)?;
        let (payload, checksum) = self.buffer[..size].split_at(payload_size);
        let expected = u16::from_le_bytes([checksum[0], checksum[1]]);
        if CRC.checksum(payload) != expected {
            return Err(postcard::Error::DeserializeBadCrc.into());
        }
        let (message, remaining) = postcard::take_from_bytes(payload)?;
        if !remaining.is_empty() {
            return Err(postcard::Error::DeserializeBadEncoding.into());
        }
        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec::Vec;

    // Fixed wire fixtures: Postcard discriminant, little-endian CRC-16/X-25,
    // one COBS block and delimiter. These contain no serialized vector prefix.
    const PING: &[u8] = &[4, 4, 0x5c, 0xb6, 0];
    const PONG: &[u8] = &[4, 5, 0xd5, 0xa7, 0];

    fn feed(decoder: &mut MessageDecoder, bytes: &[u8]) -> Vec<MyResult<Message>> {
        bytes.iter().filter_map(|&b| decoder.feed(b)).collect()
    }

    fn messages() -> [Message; 7] {
        [
            Message::GpsTime(u32::MAX),
            Message::Orientation(Orientation::TopUp),
            Message::Magnetometer(Magnetometer {
                x_gauss: 0.0,
                y_gauss: -1.25,
                z_gauss: f32::MAX,
            }),
            Message::PeerCoordinate(
                PeerId(255),
                Coordinate {
                    lat: f32::MAX,
                    lon: f32::MIN,
                },
            ),
            Message::Ping,
            Message::Pong,
            Message::SelfCoordinate(Coordinate {
                lat: 37.0001,
                lon: -122.0,
            }),
        ]
    }

    #[test]
    fn encoder_matches_fixed_wire_fixtures() {
        let mut encoder = MessageEncoder::new();
        assert_eq!(encoder.encode(&Message::Ping).unwrap(), PING);
        assert_eq!(encoder.encode(&Message::Pong).unwrap(), PONG);
    }

    #[test]
    fn decoder_accepts_fixed_wire_fixtures_without_an_encoder() {
        let mut decoder = MessageDecoder::new();
        assert_eq!(
            feed(&mut decoder, PING).pop().unwrap().unwrap(),
            Message::Ping
        );
        assert_eq!(
            feed(&mut decoder, PONG).pop().unwrap().unwrap(),
            Message::Pong
        );
        assert!(feed(&mut decoder, &[0, 0]).is_empty());
    }

    #[test]
    fn all_variants_round_trip_at_every_frame_split() {
        let mut encoder = MessageEncoder::new();
        for message in messages() {
            let frame = encoder.encode(&message).unwrap();
            assert!(frame.len() <= MessageEncoder::MAX_FRAME_SIZE);
            assert_eq!(frame.last(), Some(&0));
            assert!(frame[..frame.len() - 1].iter().all(|&b| b != 0));
            for split in 0..=frame.len() {
                let mut decoder = MessageDecoder::new();
                let mut received = feed(&mut decoder, &frame[..split]);
                received.extend(feed(&mut decoder, &frame[split..]));
                assert_eq!(received.len(), 1);
                assert_eq!(received.pop().unwrap().unwrap(), message);
                assert!(decoder.feed(0).is_none());
            }
        }
    }

    #[test]
    fn concatenated_frames_are_ordered_without_duplicates_for_every_read_size() {
        let mut encoder = MessageEncoder::new();
        let wire: Vec<u8> = messages()
            .iter()
            .flat_map(|message| encoder.encode(message).unwrap().to_vec())
            .collect();
        for read_size in 1..=wire.len() {
            let mut decoder = MessageDecoder::new();
            let received: Vec<Message> = wire
                .chunks(read_size)
                .flat_map(|chunk| feed(&mut decoder, chunk))
                .map(Result::unwrap)
                .collect();
            assert_eq!(received.as_slice(), &messages());
        }
    }

    #[test]
    fn missing_delimiter_does_not_deliver_a_partial_or_combined_frame() {
        let mut decoder = MessageDecoder::new();
        assert!(feed(&mut decoder, &PING[..PING.len() - 1]).is_empty());
        assert!(feed(&mut decoder, PONG).pop().unwrap().is_err());
        assert_eq!(
            feed(&mut decoder, PING).pop().unwrap().unwrap(),
            Message::Ping
        );
        // A delayed delimiter completes exactly one pending frame.
        assert!(feed(&mut decoder, &PONG[..PONG.len() - 1]).is_empty());
        assert_eq!(decoder.feed(0).unwrap().unwrap(), Message::Pong);
        assert!(decoder.feed(0).is_none());
    }

    #[test]
    fn malformed_cobs_bad_crc_and_truncation_recover_at_the_next_delimiter() {
        for bad in [&[5, 1, 0][..], &[4, 5, 0x5c, 0xb6, 0], &[1, 0], &[2, 4, 0]] {
            let mut decoder = MessageDecoder::new();
            let results = feed(&mut decoder, bad);
            assert_eq!(results.len(), 1);
            assert!(results[0].is_err());
            assert_eq!(
                feed(&mut decoder, PONG).pop().unwrap().unwrap(),
                Message::Pong
            );
        }
        let mut decoder = MessageDecoder::new();
        assert!(matches!(
            feed(&mut decoder, &[4, 5, 0x5c, 0xb6, 0]).pop().unwrap(),
            Err(MyError::Postcard(postcard::Error::DeserializeBadCrc))
        ));
    }

    #[test]
    fn valid_crc_cannot_hide_invalid_serialization_or_trailing_payload() {
        for payload in [&[255][..], &[4, 99]] {
            let mut raw = payload.to_vec();
            raw.extend(CRC.checksum(payload).to_le_bytes());
            let mut wire = [0; MessageEncoder::MAX_FRAME_SIZE];
            let size = cobs::try_encode(&raw, &mut wire).unwrap();
            wire[size] = 0;
            let mut decoder = MessageDecoder::new();
            assert!(
                feed(&mut decoder, &wire[..size + 1])
                    .pop()
                    .unwrap()
                    .is_err()
            );
            assert_eq!(
                feed(&mut decoder, PING).pop().unwrap().unwrap(),
                Message::Ping
            );
        }
    }

    #[test]
    fn overflow_discards_through_delimiter_including_any_apparent_frame_suffix() {
        let mut decoder = MessageDecoder::new();
        for _ in 0..ENCODED_SIZE {
            assert!(decoder.feed(1).is_none());
        }
        // Exactly the capacity reaches raw decoding, rather than overflow.
        assert!(!matches!(
            decoder.feed(0).unwrap(),
            Err(MyError::MessageTooLong)
        ));
        for _ in 0..ENCODED_SIZE + 1 {
            assert!(decoder.feed(1).is_none());
        }
        for &byte in &PING[..PING.len() - 1] {
            assert!(decoder.feed(byte).is_none());
        }
        assert!(matches!(
            decoder.feed(0).unwrap(),
            Err(MyError::MessageTooLong)
        ));
        assert_eq!(
            feed(&mut decoder, PONG).pop().unwrap().unwrap(),
            Message::Pong
        );
        assert!(decoder.feed(0).is_none());
    }
}
