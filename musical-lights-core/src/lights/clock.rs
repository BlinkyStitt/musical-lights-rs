//! UNDER CONSTUCTION
//!
//! Still thinking about how to do this. The GPS sends us a time and has a PPS. We could put an interrupt on that and increment an atomic bool
//! but I don't love that. Using another interrupt seems excessive when theres already timers running.
//! Instead, we could store the gps time along with an Instant. Then now() is the stored time + Instant.elapsed()
