//! `log` takes precedence when both backends are enabled. With neither backend,
//! logging is disabled and no logger or allocator is required.
#[cfg(all(feature = "defmt", not(feature = "log")))]
pub use defmt::{debug, error, info, trace, warn};
#[cfg(feature = "log")]
pub use log::{debug, error, info, trace, warn};

#[cfg(not(any(feature = "log", feature = "defmt")))]
#[macro_export]
macro_rules! disabled_log {
    ($($arg:tt)*) => {{ let _ = core::format_args!($($arg)*); }};
}
#[cfg(not(any(feature = "log", feature = "defmt")))]
pub use crate::disabled_log as debug;
#[cfg(not(any(feature = "log", feature = "defmt")))]
pub use crate::disabled_log as error;
#[cfg(not(any(feature = "log", feature = "defmt")))]
pub use crate::disabled_log as info;
#[cfg(not(any(feature = "log", feature = "defmt")))]
pub use crate::disabled_log as trace;
#[cfg(not(any(feature = "log", feature = "defmt")))]
pub use crate::disabled_log as warn;
