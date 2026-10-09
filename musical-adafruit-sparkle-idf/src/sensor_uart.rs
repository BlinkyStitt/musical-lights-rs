use core::ops::Fn;
use esp_idf_svc::{
    hal::uart::{UartRxDriver, UartTxDriver},
    io::Write,
    sys::TickType_t,
};
use musical_lights_core::{
    errors::{MyError, MyResult},
    logging::{info, warn},
    message::{Message, MessageDecoder, MessageEncoder},
    orientation::Orientation,
};
use std::{thread::sleep, time::Duration};

pub struct UartToSensors<'a> {
    uart: UartTxDriver<'a>,
    encoder: MessageEncoder,
}

impl<'a> UartToSensors<'a> {
    pub fn new(uart: UartTxDriver<'a>) -> Self {
        Self {
            uart,
            encoder: MessageEncoder::new(),
        }
    }

    /// Write one complete Message frame with CRC, COBS and its delimiter.
    pub fn write(&mut self, message: &Message) -> MyResult<()> {
        self.uart
            .write_all(self.encoder.encode(message)?)
            .map_err(|_| MyError::UartSend)
    }
}

pub struct UartFromSensors<'a> {
    uart: UartRxDriver<'a>,
    raw_buf: [u8; MessageEncoder::MAX_FRAME_SIZE],
    decoder: MessageDecoder,
}

impl<'a> UartFromSensors<'a> {
    pub fn new(uart: UartRxDriver<'a>) -> Self {
        Self {
            uart,
            raw_buf: [0; MessageEncoder::MAX_FRAME_SIZE],
            decoder: MessageDecoder::new(),
        }
    }

    pub fn mock_loop<F>(&mut self, process_message: F) -> MyResult<()>
    where
        F: Fn(Message) -> MyResult<()>,
    {
        warn!("mock Pong");
        process_message(Message::Pong).unwrap();

        warn!("mock orientation");
        process_message(Message::Orientation(Orientation::Unknown))?;

        loop {
            // TODO: move the gps around
            sleep(Duration::from_secs(5));
        }
    }

    /// Read until UART shutdown, retaining partial frames across reads.
    pub fn read_loop<F>(&mut self, process_message: F, read_timeout: TickType_t) -> MyResult<()>
    where
        F: Fn(Message) -> MyResult<()>,
    {
        while let Ok(count) = self.uart.read(&mut self.raw_buf, read_timeout) {
            if count == 0 {
                info!("read 0 bytes on uart");
                break;
            }
            for &byte in &self.raw_buf[..count] {
                if let Some(result) = self.decoder.feed(byte) {
                    match result {
                        Ok(message) => process_message(message)?,
                        Err(error) => warn!("invalid UART message frame: {error:?}"),
                    }
                }
            }
        }
        warn!("uart finished");
        Ok(())
    }
}
