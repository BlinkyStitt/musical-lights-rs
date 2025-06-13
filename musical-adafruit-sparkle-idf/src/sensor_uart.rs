use core::ops::Fn;
use esp_idf_svc::{
    hal::uart::{UartRxDriver, UartTxDriver},
    io::Write,
};
use esp_idf_sys::TickType_t;
use heapless::Vec;
use musical_lights_core::{
    errors::{MyError, MyResult},
    logging::{error, warn},
    message::{deserialize_with_crc, serialize_with_crc_and_cobs, Message},
};
use postcard::accumulator::{CobsAccumulator, FeedResult};

// TODO: make this work for async or sync? generics are hard
pub struct UartToSensors<'a, const N: usize> {
    uart: UartTxDriver<'a>,

    /// TODO: i think these buffers should be different lengths
    /// TODO: should these buffers just be a part of the write function?
    crc_buffer: [u8; N],
    output_buffer: [u8; N],
}

impl<'a, const N: usize> UartToSensors<'a, N> {
    pub fn new(uart: UartTxDriver<'a>) -> Self {
        Self {
            uart,
            crc_buffer: [0u8; N],
            output_buffer: [0u8; N],
        }
    }

    /// Write a Message with CRC and COBS.
    /// TODO: Return an error instead of unwrapping.
    pub fn write(&mut self, message: &Message) -> MyResult<()> {
        let encoded_len =
            serialize_with_crc_and_cobs(message, &mut self.crc_buffer, &mut self.output_buffer)?;

        self.uart
            .write_all(&self.output_buffer[..encoded_len])
            .map_err(|_| MyError::UartSend)?;

        Ok(())
    }
}

pub struct UartFromSensors<'a, const RAW_BUF_BYTES: usize, const COB_BUF_BYTES: usize> {
    /// TODO: RingBufferedUartRx?
    uart: UartRxDriver<'a>,
    raw_buf: [u8; RAW_BUF_BYTES],
    cobs_acc: CobsAccumulator<COB_BUF_BYTES>,
}

impl<'a, const RAW_BUF_BYTES: usize, const COB_BUF_BYTES: usize>
    UartFromSensors<'a, RAW_BUF_BYTES, COB_BUF_BYTES>
{
    pub fn new(uart: UartRxDriver<'a>) -> Self {
        let raw_buf = [0u8; RAW_BUF_BYTES];
        let cobs_acc = CobsAccumulator::<COB_BUF_BYTES>::new();

        // TODO: do we want a ring buffer? theres not a ton of data here, so it should be fine
        // let uart = uart.into_ring_buffered(dma_buf);

        Self {
            uart,
            raw_buf,
            cobs_acc,
        }
    }

    /// read messages from the uart until the uart shuts down
    /// TODO: how can we tell this loop to stop?
    pub fn read_loop<F>(&mut self, output: F, read_timeout: TickType_t) -> MyResult<()>
    where
        F: Fn(Message),
    {
        // TODO: how should we make this work, and what should the asserts be?
        // const _: () = assert!(RAW_BUF_BYTES > COB_BUF_BYTES, "RAW_BUF_BYTES must be greater than COB_BUF_BYTES");
        // const _: () = assert!(RAW_BUF_BYTES > 0, "RAW_BUF_BYTES must be greater than 0");
        // const RAW_BUF_BYTES: usize = max_size_with_crc_and_cobs::<T>();
        // const _: () = assert!(RAW_BUF_BYTES * 3 == COB_BUF_BYTES);

        // TODO: what size do these buffers need to be?

        // TODO: buffered read until we get a zero byte. thats the end delimeter for the cobs encoded messages
        // TODO: is read_until_idle correct?
        while let Ok(ct) = self.uart.read(&mut self.raw_buf, read_timeout) {
            if ct == 0 {
                // Finished reading input
                break;
            }

            let mut window = &self.raw_buf[..ct];

            'cobs: while !window.is_empty() {
                // TODO: RAW_BUF_BYTES is probably the wrong size for feed. calculte it from the generic types somehow
                window = match self.cobs_acc.feed::<Vec<u8, RAW_BUF_BYTES>>(window) {
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
                            Ok(msg) => {
                                output(msg);
                            }
                            Err(err) => {
                                // TODO: MyError doesn't implement defmt::Format
                                warn!("failed to deserialize message");
                            }
                        }

                        remaining
                    }
                };
            }
        }
        Ok(())
    }
}
