use thiserror::Error;

/// i don't love this pattern, but eyre no_std doesn't seem to work right
#[derive(Error, Debug)]
/// TODO: `#[cfg_attr(feature = "defmt", derive(defmt::Format))]`
pub enum MyError {
    /// TODO: from doesn't seem to work right on this
    #[error("ahrs error: {0:?}")]
    Ahrs(ahrs::AhrsError),
    #[error("cobs dest buffer too small: {0:?}")]
    CobsDestBufTooSmall(#[from] cobs::DestBufTooSmallError),
    #[error("cobs decode error: {0:?}")]
    CobsDecode(#[from] cobs::DecodeError),
    #[error("postcard error: {0:?}")]
    Postcard(#[from] postcard::Error),
    /// TODO: i don't like this. it doesn't have the actual error in it because theres too many different hardware options
    #[error("spi device error")]
    SpiDeviceError,
    /// TODO: i don't like this. it doesn't have the actual error in it because theres too many different hardware options
    #[error("uart send error")]
    UartSend,
}

pub type MyResult<T> = Result<T, MyError>;
