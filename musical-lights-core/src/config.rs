pub struct Config {
    pub broadcast_time_s: u16,
    pub default_brightness: u8,
    pub frames_per_second: u16,
    pub min_peer_meters: u16,
    pub max_peer_meters: u16,
    pub ms_per_light_pattern: u32,
    pub peer_led_ms: u16,
    /// 5-23 dBm
    pub radio_power: u16,
    /// PST = -8; PDT = -7
    pub time_zone_offset: i8,
    pub flashlight_density: u8,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            broadcast_time_s: 2,
            default_brightness: 32,
            frames_per_second: 50,
            min_peer_meters: 30,
            max_peer_meters: 5000,
            ms_per_light_pattern: 10 * 60 * 1000,
            peer_led_ms: 800,
            radio_power: 20,
            time_zone_offset: -7,
            flashlight_density: 3,
        }
    }
}
