//! Deployment profile. Regenerate this file from measured data with
//! validation/lights/profile.py. Defaults are explicitly uncalibrated.
use musical_lights_core::{audio::loudness::Calibration, lights::LedResponse};
pub fn input_calibration() -> eyre::Result<Calibration> {
    Ok(Calibration::default())
}
pub fn led_response() -> eyre::Result<LedResponse> {
    Ok(LedResponse::default())
}
