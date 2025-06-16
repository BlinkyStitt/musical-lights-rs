#[cfg(feature = "log")]
pub use log::{debug, error, info, trace, warn};

/// TODO: This does not work exactly right. they have different syntax
#[cfg(not(feature = "log"))]
pub use defmt::{debug, error, info, trace, warn};
