use core::ops::Fn;
use embassy_stm32::{
    mode::Async,
    usart::{UartRx, UartTx},
};
use embedded_io_async::Write;
use musical_lights_core::{
    errors::{MyError, MyResult},
    logging::warn,
    message::{Message, MessageDecoder, MessageEncoder},
};

pub struct UartToSparkle<'a> {
    uart: UartTx<'a, Async>,
    encoder: MessageEncoder,
}

impl<'a> UartToSparkle<'a> {
    pub fn new(uart: UartTx<'a, Async>) -> Self {
        Self {
            uart,
            encoder: MessageEncoder::new(),
        }
    }

    /// Write one complete Message frame with CRC, COBS and its delimiter.
    pub async fn write(&mut self, message: &Message) -> MyResult<()> {
        self.uart
            .write_all(self.encoder.encode(message)?)
            .await
            .map_err(|_| MyError::UartSend)
    }
}

pub struct UartFromSparkle<'a> {
    uart: UartRx<'a, Async>,
    raw_buf: [u8; MessageEncoder::MAX_FRAME_SIZE],
    decoder: MessageDecoder,
}

impl<'a> UartFromSparkle<'a> {
    pub const fn new(uart: UartRx<'a, Async>) -> Self {
        Self {
            uart,
            raw_buf: [0; MessageEncoder::MAX_FRAME_SIZE],
            decoder: MessageDecoder::new(),
        }
    }

    /// Read until UART shutdown, retaining partial frames across reads.
    pub async fn read_loop<F, Fut>(&mut self, output: F) -> MyResult<()>
    where
        F: Fn(Message) -> Fut,
        Fut: Future<Output = ()>,
    {
        while let Ok(count) = self.uart.read_until_idle(&mut self.raw_buf).await {
            if count == 0 {
                break;
            }
            for &byte in &self.raw_buf[..count] {
                if let Some(result) = self.decoder.feed(byte) {
                    match result {
                        Ok(message) => output(message).await,
                        // MyError has no defmt::Format implementation.
                        Err(_) => warn!("invalid UART message frame, dropping data"),
                    }
                }
            }
        }
        Ok(())
    }
}
