use serde::Deserialize;

#[derive(Deserialize)]
struct Config {
    #[serde(default = "default_broadcast_time_s")]
    broadcast_time_s: u16,
    #[serde(default = "default_default_brightness")]
    default_brightness: u8,
    #[serde(default = "default_frames_per_second")]
    frames_per_second: u16,
    #[serde(default = "default_min_peer_distance")]
    min_peer_distance: u16,
    #[serde(default = "default_max_peer_distance")]
    max_peer_distance: u16,
    #[serde(default = "default_ms_per_light_pattern")]
    ms_per_light_pattern: u32,
    #[serde(default = "default_peer_led_ms")]
    peer_led_ms: u16,
    #[serde(default = "default_radio_power")]
    radio_power: u16,
    #[serde(default = "default_time_zone_offset")]
    time_zone_offset: i8,
    #[serde(default = "default_flashlight_density")]
    flashlight_density: u8,
}

fn default_broadcast_time_s() -> u16 {
    2
}

fn default_default_brightness() -> u8 {
    32
}

fn default_frames_per_second() -> u16 {
    50
}

/// in meters
fn default_max_peer_distance() -> u16 {
    5000
}

// in meters
fn default_min_peer_distance() -> u16 {
    30
}

fn default_ms_per_light_pattern() -> u32 {
    10 * 60 * 1000
}

fn default_peer_led_ms() -> u16 {
    800
}

/// 5-23 dBm
fn default_radio_power() -> u16 {
    20
}

fn default_time_zone_offset() -> i8 {
    // PST = -8; PDT = -7
    -7
}

fn default_flashlight_density() -> u8 {
    3
}
