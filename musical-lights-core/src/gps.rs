//! GPS product 746, 9600 baud, 1 Hz. Coordinates stay in volatile memory.
use nmea::{
    ParseResult,
    sentences::{FixType, GgaData, RmcData, rmc::RmcStatusOfFix},
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fix {
    pub latitude_e7: i32,
    pub longitude_e7: i32,
    pub utc_ms: u64,
    pub captured_ms: u64,
    pub valid: bool,
    pub time_valid: bool,
    pub altitude_m: Option<f32>,
    pub hdop: Option<f32>,
}
impl Fix {
    pub fn age_ms(self, now: u64) -> u32 {
        now.saturating_sub(self.captured_ms).min(u32::MAX as u64) as u32
    }
}

#[derive(Default)]
pub struct GpsParser {
    rmc: Option<(RmcData, u64)>,
    gga: Option<(GgaData, u64)>,
    last_epoch: Option<u64>,
}
impl GpsParser {
    pub fn push(&mut self, line: &str, now_ms: u64) -> Option<Fix> {
        // nmea validates the checksum. Reject extra data and invalid hemispheres
        // explicitly; a receiver must never turn a missing sign into north/east.
        let line = line.trim_end_matches(['\r', '\n']);
        let star = line.find('*')?;
        if star + 3 != line.len() || !line.starts_with('$') {
            return None;
        }
        if line[..star].split(',').count() > 24 {
            return None;
        }
        let fields: heapless::Vec<&str, 24> = line[..star].split(',').collect();
        match nmea::parse_str(line).ok()? {
            ParseResult::RMC(rmc) => {
                if rmc.status_of_fix != RmcStatusOfFix::Invalid
                    && (!matches!(fields.get(4), Some(&"N" | &"S"))
                        || !matches!(fields.get(6), Some(&"E" | &"W")))
                {
                    return None;
                }
                self.rmc = Some((rmc, now_ms));
            }
            ParseResult::GGA(gga) => {
                if gga.fix_type != Some(FixType::Invalid)
                    && (!matches!(fields.get(3), Some(&"N" | &"S"))
                        || !matches!(fields.get(5), Some(&"E" | &"W")))
                {
                    return None;
                }
                self.gga = Some((gga, now_ms));
            }
            _ => return None,
        }
        let (rmc, rmc_at) = self.rmc.as_ref()?;
        let (gga, gga_at) = self.gga.as_ref()?;
        let fix_time = rmc.fix_time?;
        if gga.fix_time != Some(fix_time)
            || rmc_at.abs_diff(*gga_at) >= 1000
            || now_ms.saturating_sub((*rmc_at).min(*gga_at)) >= 1000
        {
            return None;
        }
        let epoch = rmc
            .fix_date?
            .and_time(fix_time)
            .and_utc()
            .timestamp_millis();
        if !(1577836800000..4102444800000).contains(&epoch) {
            return None;
        }
        let utc_ms = epoch as u64;
        if self.last_epoch.is_some_and(|last| utc_ms <= last) {
            return None;
        }
        let valid = matches!(
            rmc.status_of_fix,
            RmcStatusOfFix::Autonomous | RmcStatusOfFix::Differential
        ) && matches!(gga.fix_type, Some(FixType::Gps | FixType::DGps));
        let coordinates = rmc.lat.zip(rmc.lon).filter(|(lat, lon)| {
            lat.is_finite()
                && lon.is_finite()
                && (-90.0..=90.0).contains(lat)
                && (-180.0..=180.0).contains(lon)
        });
        let valid = valid && coordinates.is_some();
        let (lat, lon) = if valid { coordinates? } else { (0.0, 0.0) };
        self.last_epoch = Some(utc_ms);
        Some(Fix {
            latitude_e7: num::Float::round(lat * 1e7) as i32,
            longitude_e7: num::Float::round(lon * 1e7) as i32,
            utc_ms,
            captured_ms: (*rmc_at).min(*gga_at),
            valid,
            time_valid: rmc.status_of_fix != RmcStatusOfFix::Invalid,
            altitude_m: gga
                .altitude
                .zip(gga.geoid_separation)
                .map(|(altitude, geoid)| altitude + geoid)
                .filter(|v| v.is_finite()),
            hdop: gga.hdop.filter(|v| v.is_finite() && *v > 0.0),
        })
    }
}

/// Extend consecutive 32-bit, 1 MHz captures. Call at least once per wrap.
#[derive(Default)]
pub struct PpsCounter {
    previous: Option<u32>,
    elapsed_us: u64,
}
impl PpsCounter {
    pub const fn new() -> Self {
        Self {
            previous: None,
            elapsed_us: 0,
        }
    }
    pub fn capture(&mut self, value: u32) -> u64 {
        self.elapsed_us += self
            .previous
            .map_or(value as u64, |last| value.wrapping_sub(last) as u64);
        self.previous = Some(value);
        self.elapsed_us
    }
}

/// Resolve a captured edge against the extended counter, including timer wrap.
/// Discard stale or future captures instead of labeling task wake-up time as PPS.
pub fn pps_timestamp(captured: u32, current_us: u64) -> Option<u64> {
    let delay = (current_us as u32).wrapping_sub(captured);
    if delay > 2_000_000 {
        return None;
    }
    current_us.checked_sub(delay as u64)
}
