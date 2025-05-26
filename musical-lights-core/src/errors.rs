use thiserror::Error;

/// i don't love this pattern, but eyre no_std doesn't seem to work right
#[derive(Error, Debug)]
pub enum MyError {
    #[error("postcard error: {0:?}")]
    Postcard(#[from] postcard::Error),
    #[error("cobs dest buffer too small: {0:?}")]
    CobsDestBufTooSmall(#[from] cobs::DestBufTooSmallError),
    #[error("cobs decode error: {0:?}")]
    CobsDecode(#[from] cobs::DecodeError),
}

pub type MyResult<T> = Result<T, MyError>;
