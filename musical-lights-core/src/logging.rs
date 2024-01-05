#[cfg(feature = "log")]
pub use log::{debug, error, info, trace, warn};

#[cfg(not(feature = "log"))]
pub use defmt::{debug, error, info, trace, warn};
