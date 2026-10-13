use crate::{
    clock::{Anchor, ClockState, PatternClock, UtcClock},
    controller::Controller,
    gps::{GpsParser, PpsCounter},
    message::*,
    provisioning::*,
    radio::*,
    storage::*,
};
use std::vec::Vec;
fn unhex(text: &str) -> Vec<u8> {
    text.split_whitespace()
        .flat_map(|part| {
            part.as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u8::from_str_radix(core::str::from_utf8(b).unwrap(), 16).unwrap())
        })
        .collect()
}
fn nmea(body: &str) -> std::string::String {
    std::format!("${body}*{:02X}", body.bytes().fold(0, |a, b| a ^ b))
}
#[test]
fn gps_checksums_matching_epochs_hemispheres_and_invalid_fixes() {
    let mut gps = GpsParser::default();
    let rmc = nmea("GPRMC,120000.000,A,3746.4940,N,12225.1640,W,0.0,0.0,121026,,,A");
    let gga = nmea("GPGGA,120000.000,3746.4940,N,12225.1640,W,1,08,0.9,10.0,M,30.0,M,,");
    assert!(gps.push(&rmc, 100).is_none());
    let fix = gps.push(&gga, 200).unwrap();
    assert!(fix.valid);
    assert!(fix.time_valid);
    assert_eq!(fix.latitude_e7, 377749000);
    assert_eq!(fix.longitude_e7, -1224194000);
    assert_eq!(fix.altitude_m, Some(40.0));
    assert_eq!(fix.age_ms(1200), 1100);
    assert!(gps.push(&gga, 300).is_none());
    let mut broken = rmc.clone().into_bytes();
    broken[20] ^= 1;
    assert!(
        gps.push(core::str::from_utf8(&broken).unwrap(), 1000)
            .is_none()
    );
    let later = nmea("GPRMC,120001.000,A,3746.4940,S,12225.1640,E,0.0,0.0,121026,,,A");
    assert!(gps.push(&later, 1100).is_none());
    assert!(gps.push(&gga, 1200).is_none());
    let later_gga = nmea("GPGGA,120001.000,3746.4940,S,12225.1640,E,1,08,0.9,10.0,M,30.0,M,,");
    let fix = gps.push(&later_gga, 1300).unwrap();
    assert!(fix.latitude_e7 < 0 && fix.longitude_e7 > 0);
    let invalid = nmea("GPRMC,120002.000,V,,,,,,,121026,,,N");
    let invalid_gga = nmea("GPGGA,120002.000,,,,,0,00,99.9,,M,,M,,");
    assert!(gps.push(&invalid, 2100).is_none());
    let fix = gps.push(&invalid_gga, 2200).unwrap();
    assert!(!fix.valid);
    assert!(!fix.time_valid);
    assert_eq!(fix.latitude_e7, 0);
}
#[test]
fn gps_cannot_join_delayed_or_different_epochs() {
    let mut gps = GpsParser::default();
    assert!(
        gps.push(
            &nmea("GPRMC,120000.000,A,0000.0,N,00000.0,E,0,0,121026,,,A"),
            0
        )
        .is_none()
    );
    assert!(
        gps.push(
            &nmea("GPGGA,120000.000,0000.0,N,00000.0,E,1,08,1.0,0,M,0,M,,"),
            1000
        )
        .is_none()
    );
    assert!(
        gps.push(
            &nmea("GPRMC,120001.000,A,0000.0,X,00000.0,E,0,0,121026,,,A"),
            1100
        )
        .is_none()
    );
}
#[test]
fn pps_wrap_extends_one_mhz_capture() {
    let mut timer = PpsCounter::default();
    assert_eq!(timer.capture(u32::MAX - 5), u32::MAX as u64 - 5);
    assert_eq!(timer.capture(994), u32::MAX as u64 + 995);
}
const EPOCH: u64 = 1791806400000;
#[test]
fn clock_requires_five_measured_anchors_and_expires_holdover() {
    let mut clock = UtcClock::default();
    for i in 0..5 {
        assert_eq!(
            clock.accept(Anchor {
                utc_ms: EPOCH + i * 1000,
                monotonic_ms: i * 1000,
                uncertainty_ms: 10
            }),
            i == 4
        );
    }
    assert_eq!(clock.state(), ClockState::Locked);
    clock.update(7001);
    assert_eq!(clock.state(), ClockState::Holdover);
    assert!(clock.utc(7001).is_some());
    clock.update(1804001);
    assert_eq!(clock.state(), ClockState::Untrusted);
    assert!(clock.utc(1804001).is_none());
    let mut unmeasured = UtcClock::default();
    for i in 0..10 {
        assert!(!unmeasured.accept(Anchor {
            utc_ms: EPOCH + i * 1000,
            monotonic_ms: i * 1000,
            uncertainty_ms: u32::MAX
        }));
    }
    assert_eq!(unmeasured.state(), ClockState::Acquiring);
    assert!(!unmeasured.accept(Anchor {
        utc_ms: EPOCH + 10000,
        monotonic_ms: 10000,
        uncertainty_ms: 10
    }));
}
#[test]
fn clock_discontinuity_reacquires_and_presentation_corrects_without_backward_motion() {
    let mut clock = UtcClock::default();
    for i in 0..5 {
        clock.accept(Anchor {
            utc_ms: EPOCH + i * 1000,
            monotonic_ms: i * 1000,
            uncertainty_ms: 10,
        });
    }
    assert!(!clock.accept(Anchor {
        utc_ms: EPOCH + 5500,
        monotonic_ms: 5000,
        uncertainty_ms: 10
    }));
    assert_eq!(clock.state(), ClockState::Acquiring);
    assert!(clock.utc(5000).is_none());
    let mut display = PatternClock::default();
    assert!(!display.tick(0, None).synchronized);
    assert!(!display.tick(1000, Some((EPOCH, 10))).synchronized);
    assert_eq!(display.tick(1300, Some((EPOCH + 300, 10))).intensity, 0.0);
    assert!(display.tick(1600, Some((EPOCH + 600, 10))).synchronized);
    let a = display.tick(1700, Some((EPOCH + 650, 10)));
    let b = display.tick(1800, Some((EPOCH + 750, 10)));
    assert!(b.seconds > a.seconds);
    assert!((b.seconds - a.seconds - 0.0995).abs() < 1e-6);
}
fn roster() -> Roster {
    Roster {
        revision: 1,
        peers: (1..=8)
            .map(|id| Identity {
                id,
                color: (id - 1) as u8,
            })
            .collect(),
    }
}
fn origin() -> Report {
    Report {
        group: 0x01020304,
        origin: 1,
        relay: 1,
        boot: 1,
        sequence: 1,
        utc_ms: 1791590400000,
        age_ms: 1000,
        latitude_e7: 377749000,
        longitude_e7: -1224194000,
        accuracy_dm: 50,
        color: 0,
        flags: 7,
        hop: 1,
    }
}
fn key() -> [u8; 32] {
    core::array::from_fn(|i| i as u8)
}
#[test]
fn authenticated_radio_matches_independent_origin_and_relay_fixtures() {
    // Fixed Python/OpenSSL fixtures from design-v2; independent of this encoder.
    let bytes = unhex(
        "01 04 03 02 01 01 00 01 00 01 00 00 00 01 00 00 00 00 00 1c 23 a1 01 00 00 e8 03 00 00 08 fe 83 16 30 48 08 b7 32 00 00 07 00 01 03 dc f4 1a 29 b9 b7 97 8c be 40 dd 03 e1 81 db",
    );
    assert_eq!(Report::decode(&bytes, &key()), Ok(origin()));
    assert_eq!(origin().encode(&key()).unwrap().as_slice(), bytes);
    let relay = unhex(
        "01 04 03 02 01 01 00 02 00 01 00 00 00 01 00 00 00 00 00 1c 23 a1 01 00 00 b0 04 00 00 08 fe 83 16 30 48 08 b7 32 00 00 07 00 02 1f fc da af 7a f8 cf d9 01 c8 47 db 94 2b 14 ce",
    );
    let mut report = origin();
    report.relay = 2;
    report.age_ms = 1200;
    report.hop = 2;
    assert_eq!(Report::decode(&relay, &key()), Ok(report));
    assert_eq!(report.encode(&key()).unwrap().as_slice(), relay);
    let mut bad = bytes.clone();
    bad[29] ^= 1;
    assert_eq!(
        Report::decode(&bad, &key()),
        Err(RadioError::Authentication)
    );
    assert_eq!(
        Report::decode(&bytes[..58], &key()),
        Err(RadioError::Length)
    );
    for flags in [0x8007, 0x0002, 0x00c7, 0x4007] {
        let mut r = origin();
        r.flags = flags;
        assert_eq!(r.encode(&key()), Err(RadioError::Invalid));
    }
}
#[test]
fn network_rejects_unknown_replay_stale_and_future_reports_without_eviction() {
    let mut network = Network::new(2, origin().group, roster(), true).unwrap();
    assert!(
        network
            .receive(origin(), 0, Some((origin().utc_ms + 1000, 10)), 0)
            .is_ok()
    );
    let before = network.peers[0].unwrap();
    assert_eq!(
        network.receive(origin(), 1, None, 0),
        Err(RadioError::Replay)
    );
    let mut unknown = origin();
    unknown.origin = 9;
    unknown.relay = 9;
    unknown.sequence = 2;
    assert_eq!(
        network.receive(unknown, 2, None, 0),
        Err(RadioError::UnknownPeer)
    );
    let mut stale = origin();
    stale.sequence = 2;
    stale.age_ms = 60001;
    assert_eq!(network.receive(stale, 2, None, 0), Err(RadioError::Expired));
    let mut future = origin();
    future.sequence = 2;
    future.utc_ms += 10000;
    assert_eq!(
        network.receive(future, 2, Some((origin().utc_ms, 10)), 0),
        Err(RadioError::Future)
    );
    assert_eq!(network.peers[0].unwrap().report, before.report);
    assert_eq!(before.freshness(15000), Freshness::Stale);
    assert_eq!(before.freshness(60000), Freshness::Expired);
}
#[test]
fn relays_cancel_duplicates_prioritize_self_and_bound_tokens_and_residence() {
    let mut network = Network::new(2, origin().group, roster(), true).unwrap();
    network.receive(origin(), 100, None, 0).unwrap();
    assert!(network.next_relay(200, true, false, 0).is_none());
    assert!(network.next_relay(200, false, true, 0).is_none());
    let report = network.next_relay(220, false, false, 0).unwrap();
    assert_eq!(report.hop, 2);
    assert_eq!(report.age_ms, 1120);
    assert_eq!(report.origin, 1);
    assert_eq!(report.relay, 2);
    let mut newer = origin();
    newer.sequence = 2;
    network.receive(newer, 300, None, 0).unwrap();
    assert!(network.next_relay(400, false, false, 0).is_none());
    assert_eq!(network.relay_drops, 1);
    let mut other = Network::new(2, origin().group, roster(), true).unwrap();
    other.receive(origin(), 0, None, 0).unwrap();
    let mut duplicate = origin();
    duplicate.relay = 3;
    duplicate.hop = 2;
    duplicate.age_ms = 1100;
    assert_eq!(
        other.receive(duplicate, 100, None, 0),
        Err(RadioError::Replay)
    );
    assert!(other.next_relay(500, false, false, 0).is_none());
    assert!(!other.peers[0].unwrap().verified);
    for id in 3..=8 {
        let mut r = origin();
        r.origin = id;
        r.relay = id;
        r.color = (id - 1) as u8;
        other.receive(r, 1000, None, 0).unwrap();
    }
    assert!(other.peers.iter().flatten().count() <= 7);
    assert!(other.next_relay(2001, false, false, 0).is_none());
    assert_eq!(other.relay_drops, 6);
}
#[test]
fn revised_uart_fixture_and_stream_recovery_do_not_accept_old_payloads() {
    let heartbeat = Message::Heartbeat(Heartbeat {
        role: 0,
        boot: L4::new(1),
        uptime: L4::new(2),
        health: L2::new(0x1800),
    });
    let fixture = unhex("0301040201010102020101010418887700");
    let mut encoder = MessageEncoder::new();
    assert_eq!(encoder.encode(&heartbeat).unwrap(), fixture);
    for split in 0..fixture.len() {
        let mut decoder = MessageDecoder::new();
        let mut messages = Vec::new();
        for b in &fixture[..split] {
            if let Some(r) = decoder.feed(*b) {
                messages.push(r.unwrap());
            }
        }
        for b in &fixture[split..] {
            if let Some(r) = decoder.feed(*b) {
                messages.push(r.unwrap());
            }
        }
        assert_eq!(messages.as_slice(), core::slice::from_ref(&heartbeat));
    }
    let mut decoder = MessageDecoder::new();
    for _ in 0..600 {
        assert!(decoder.feed(1).is_none());
    }
    assert!(decoder.feed(0).unwrap().is_err());
    let mut recovered = None;
    for b in fixture {
        if let Some(r) = decoder.feed(b) {
            recovered = Some(r.unwrap());
        }
    }
    assert_eq!(recovered, Some(heartbeat));
    for b in unhex("020403265600") {
        if let Some(r) = decoder.feed(b) {
            assert!(r.is_err());
        }
    } // Old Ping frame.
}
#[test]
fn uart_complete_snapshot_and_commands_fit_the_512_byte_limit() {
    let mut snapshot = StateSnapshot {
        boot: L4::new(1),
        sequence: L4::new(1),
        roster_revision: L4::new(1),
        slot: 0,
        count: 8,
        ..Default::default()
    };
    for id in 2..=8 {
        snapshot
            .peers
            .push(Peer {
                id: L2::new(id),
                origin_boot: L4::new(1),
                sequence: L4::new(1),
                position: Position::default(),
                health: L2::new(0),
                hop: 1,
                rssi: L2::new(i16::MIN as u16),
                snr: i8::MIN as u8,
                color: (id - 1) as u8,
            })
            .unwrap();
    }
    let mut encoder = MessageEncoder::new();
    let frame = encoder.encode(&Message::StateSnapshot(snapshot)).unwrap();
    assert!(frame.len() <= 324);
    let command = Message::Command(Command {
        target_stm_boot: L4::new(1),
        client_epoch: L4::new(1),
        command_id: L4::new(1),
        operation: 1,
        expected_generation: L4::new(0),
        data: heapless::Vec::from_slice(&[1; 384]).unwrap(),
    });
    assert!(encoder.encode(&command).unwrap().len() <= 410);
}
#[derive(Clone)]
struct MemoryFlash {
    bytes: Vec<u8>,
    remaining: Option<usize>,
}
impl MemoryFlash {
    fn new() -> Self {
        Self {
            bytes: std::vec![255;SECTOR*2],
            remaining: None,
        }
    }
}
impl Flash for MemoryFlash {
    fn read(&mut self, offset: usize, data: &mut [u8]) -> Result<(), StorageError> {
        data.copy_from_slice(&self.bytes[offset..offset + data.len()]);
        Ok(())
    }
    fn write(&mut self, offset: usize, data: &[u8]) -> Result<(), StorageError> {
        for (i, &b) in data.iter().enumerate() {
            if self.remaining == Some(0) {
                return Err(StorageError::Io);
            }
            if let Some(left) = self.remaining.as_mut() {
                *left -= 1;
            }
            assert_eq!(self.bytes[offset + i] & b, b);
            self.bytes[offset + i] &= b;
        }
        Ok(())
    }
    fn erase(&mut self, offset: usize, length: usize) -> Result<(), StorageError> {
        self.bytes[offset..offset + length].fill(255);
        Ok(())
    }
}
#[test]
fn checkpoint_power_loss_at_every_program_word_preserves_committed_state() {
    let mut journal = Journal::open(MemoryFlash::new()).unwrap();
    let mut old = journal.checkpoint.clone();
    old.boot = L4::new(1);
    journal.commit(&old).unwrap();
    let original = journal.into_flash();
    let mut next = old.clone();
    next.boot = L4::new(2);
    for boundary in (0..=PAGE + 4).step_by(4) {
        let mut flash = original.clone();
        flash.remaining = Some(boundary);
        let mut journal = Journal::open(flash).unwrap();
        let accepted = journal.commit(&next).is_ok();
        let mut flash = journal.into_flash();
        flash.remaining = None;
        let recovered = Journal::open(flash).unwrap();
        assert_eq!(
            recovered.checkpoint.boot.get(),
            if accepted { 2 } else { 1 },
            "boundary {boundary}"
        );
    }
}
#[test]
fn committed_corruption_does_not_roll_back_to_an_older_sector() {
    let mut journal = Journal::open(MemoryFlash::new()).unwrap();
    for i in 1..35 {
        let mut next = journal.checkpoint.clone();
        next.boot = L4::new(i);
        journal.commit(&next).unwrap();
    }
    let mut flash = journal.into_flash();
    let recovered = Journal::open(flash.clone()).unwrap();
    assert_eq!(recovered.checkpoint.boot.get(), 34);
    flash.bytes[3 * PAGE + 20] ^= 1; // Current sector after rollover is sector 0; this is a committed checkpoint.
    assert!(matches!(Journal::open(flash), Err(StorageError::Corrupt)));
}
fn stm() -> StmRecord<[u8; 32]> {
    StmRecord {
        schema: L2::new(1),
        generation: L4::new(1),
        device_id: L2::new(1),
        group_id: L4::new(0x01020304),
        key_id: L4::new(1),
        key: key(),
        roster_revision: L4::new(1),
        roster: (1..=8)
            .map(|id| RosterEntry {
                id: L2::new(id),
                color: (id - 1) as u8,
            })
            .collect(),
        radio_profile: L2::new(1),
        interval_ms: L4::new(5000),
        relay_enabled: false,
        sensor_profile: L2::new(1),
        mount_revision: L4::new(1),
        gps_profile: L2::new(1),
        battery_profile: L2::new(0),
        calibration: None,
    }
}
fn replace(boot: u32, id: u32, settings: StmRecord<Option<[u8; 32]>>, generation: u32) -> Command {
    Command {
        target_stm_boot: L4::new(boot),
        client_epoch: L4::new(1),
        command_id: L4::new(id),
        operation: 1,
        expected_generation: L4::new(generation),
        data: encode_record(&settings).unwrap(),
    }
}
#[test]
fn command_completion_and_settings_share_one_commit_point_and_recover_after_restart() {
    let mut controller = Controller::boot(MemoryFlash::new()).unwrap();
    let settings = stm();
    assert!(settings.valid());
    let command = replace(
        controller.boot_id(),
        1,
        settings.clone().map_key(Some(key())),
        0,
    );
    assert_eq!(controller.command(&command, 0).status, 0);
    assert_eq!(controller.command(&command, 1).status, 1);
    let flash = controller.journal.into_flash();
    let mut restarted = Controller::boot(flash).unwrap();
    let mut retry = command.clone();
    retry.target_stm_boot = L4::new(restarted.boot_id());
    assert_eq!(restarted.command(&retry, 2).status, 1);
    assert_eq!(restarted.generation(), 1);
    let mut changed = retry.clone();
    changed.data[0] ^= 1;
    assert_eq!(restarted.command(&changed, 3).status, 2);
    let public = restarted.settings.as_ref().unwrap().public_bytes().unwrap();
    assert_eq!(decode_record::<StmRecord<u8>>(&public).unwrap().key, 1);
    assert!(public.len() <= 188);
    let mut broken = public.clone();
    broken[3] ^= 1;
    assert!(decode_record::<StmRecord<u8>>(&broken).is_err());
}
#[test]
fn stable_shared_pattern_sections_do_not_depend_on_reachable_peers() {
    let roster = roster();
    for id in 1..=8 {
        let slot = roster.slot(id).unwrap();
        let hue = crate::amulet::shared_hue(slot, 8, 0, 494, 0.0).unwrap();
        assert_eq!(hue, slot as f64 / 8.0);
    }
    assert!(crate::amulet::shared_hue(255, 0, 0, 494, 0.0).is_none());
    let mut missing = Network::new(2, origin().group, roster.clone(), false).unwrap();
    missing.receive(origin(), 0, None, 0).unwrap();
    assert_eq!(missing.roster.slot(8), Some(7));
    assert_eq!(missing.roster.peers.len(), 8);
}
fn sparkle() -> SparkleRecord {
    SparkleRecord {
        generation: L4::new(1),
        total_ma: L2::new(2500),
        reserve_ma: L2::new(500),
        circle_ma: L2::new(1000),
        halo_ma: L2::new(250),
        inner_ma: L2::new(375),
        outer_ma: L2::new(375),
        mode: 2,
        ..Default::default()
    }
}
#[test]
fn all_four_outputs_share_patterns_blanking_and_encoded_current_caps() {
    use palette::LinSrgb;
    use smart_leds::RGB8;
    let mut settings = sparkle();
    assert!(settings.valid());
    let mut renderer = crate::amulet::Renderer::default();
    let snapshot = StateSnapshot {
        boot: L4::new(1),
        sequence: L4::new(1),
        slot: 0,
        count: 8,
        roster_revision: L4::new(1),
        ..Default::default()
    };
    let mut linear = [LinSrgb::new(0.0, 0.0, 0.0); 494];
    renderer.render(&settings, Some((&snapshot, 0)), 0, 0.0, false, &mut linear);
    for (start, end) in [(0, 256), (256, 320), (320, 404), (404, 494)] {
        assert!(
            linear[start..end]
                .iter()
                .any(|p| p.red + p.green + p.blue > 0.0)
        );
    }
    let profiles = core::array::from_fn(|_| crate::lights::LedResponse::default());
    let mut bytes = [RGB8::default(); 494];
    let scale = crate::amulet_output::encode(&settings, &profiles, &linear, &mut bytes).unwrap();
    assert!((0.0..=1.0).contains(&scale));
    assert!(crate::amulet_output::current_ua(&bytes) + 500000 <= 2500000);
    settings.blanked = true;
    renderer.render(&settings, Some((&snapshot, 0)), 1, 1.0, false, &mut linear);
    assert!(linear.iter().all(|p| *p == LinSrgb::new(0.0, 0.0, 0.0)));
    assert!(!SparkleRecord::default().valid());
    settings.blanked = false;
    settings.preset = 4;
    renderer.render(
        &settings,
        Some((&snapshot, 0)),
        1000,
        0.0,
        false,
        &mut linear,
    );
    assert!(linear.iter().all(|p| *p == LinSrgb::new(0.0, 0.0, 0.0)));
}

#[test]
fn magnetic_model_matches_all_noaa_wmm2025_reference_values() {
    // NOAA/NCEI WMM2025COF.zip, WMM2025_TEST_VALUES.txt, downloaded 2026-10-12.
    // U.S. Government reference data; no copyright protection applies.
    use world_magnetic_model::{
        GeomagneticField,
        time::Date,
        uom::si::{
            angle::degree,
            f32::{Angle, Length},
            length::kilometer,
        },
    };
    let data = include_str!("../tests/fixtures/WMM2025_TEST_VALUES.txt");
    let mut checked = 0;
    for line in data
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
    {
        let values: Vec<f32> = line
            .split_whitespace()
            .map(|v| v.parse().unwrap())
            .collect();
        let year = values[0] as i32;
        let days = if year % 4 == 0 { 366.0 } else { 365.0 };
        let ordinal = ((values[0] - year as f32) * days).round() as u16 + 1;
        let date = Date::from_ordinal_date(year, ordinal.min(days as u16)).unwrap();
        let model = GeomagneticField::new(
            Length::new::<kilometer>(values[1]),
            Angle::new::<degree>(values[2]),
            Angle::new::<degree>(values[3]),
            date,
        )
        .unwrap();
        assert!(
            (model.declination().get::<degree>() - values[4]).abs() < 0.03,
            "{line}"
        );
        checked += 1;
    }
    assert_eq!(checked, 100);
}

fn coefficients() -> Coefficients {
    let zero = F4::new(0.0);
    let one = F4::new(1.0);
    let mut c = Coefficients {
        schema: L2::new(1),
        sensor_profile: L2::new(1),
        mount_revision: L4::new(1),
        revision: L4::new(1),
        mag_samples: L4::new(2000),
        temperature: L2::new((-32768i16) as u16),
        accel_bias: [zero; 3],
        accel_scale: [one; 3],
        gyro_bias: [zero; 3],
        mag_bias: [zero; 3],
        mag_matrix: [one, zero, zero, zero, one, zero, zero, zero, one],
        field: F4::new(50.0),
        holdout_rms: zero,
        holdout_max: zero,
        solver: L2::new(1),
        crc: L4::new(0),
    };
    let mut bytes = [0; 120];
    postcard::to_slice(&c, &mut bytes).unwrap();
    let crc = crc::Crc::<u32>::new(&crc::CRC_32_ISO_HDLC).checksum(&bytes[..116]);
    c.crc = L4::new(crc);
    c
}
#[test]
fn calibrated_heading_has_recovery_declination_and_independent_sample_deadlines() {
    use crate::{
        navigation::{HeadingEstimator, ImuSample},
        sensor_mount::ImuMounts,
    };
    let calibration = coefficients();
    assert!(calibration.valid(1, 1));
    let mut estimator = HeadingEstimator::default();
    let mut last = None;
    for at in (0..=2100).step_by(10) {
        let sample = ImuSample {
            accel: [0.0, 0.0, 9.80665],
            gyro: [0.0; 3],
            mag: [0.0, 50.0, 0.0],
            accel_at: at,
            gyro_at: at,
            mag_at: at,
            saturated: false,
        };
        let heading = estimator.update(
            sample,
            Some(&calibration),
            ImuMounts::default(),
            Some(15.0),
            at,
        );
        assert_eq!(heading.quality, if at < 2000 { 2 } else { 4 });
        last = Some((sample, heading));
    }
    let (sample, heading) = last.unwrap();
    assert_eq!(heading.magnetic.get(), 0);
    assert_eq!(heading.true_north.get(), 1500);
    let magnetic = estimator.update(sample, Some(&calibration), ImuMounts::default(), None, 2100);
    assert_eq!(magnetic.quality, 3);
    let missing = estimator.update(
        sample,
        Some(&calibration),
        ImuMounts::default(),
        Some(15.0),
        2151,
    );
    assert_eq!(missing.quality, 0);
    assert_eq!(missing.true_north.get(), 0);
    let mut tilted = sample;
    tilted.accel = [
        0.0,
        9.80665 * (75.0_f64.to_radians().sin()),
        9.80665 * (75.0_f64.to_radians().cos()),
    ];
    assert_eq!(
        estimator
            .update(tilted, Some(&calibration), ImuMounts::default(), None, 2100)
            .quality,
        6
    );
    let mut saturated = sample;
    saturated.saturated = true;
    let value = estimator.update(
        saturated,
        Some(&calibration),
        ImuMounts::default(),
        None,
        2100,
    );
    assert_eq!(value.quality, 0);
    assert_ne!(value.faults.get() & 64, 0);
}
#[test]
fn calibration_begin_and_stage_cannot_recreate_a_volatile_run_after_restart() {
    let mut controller = Controller::boot(MemoryFlash::new()).unwrap();
    let c = replace(controller.boot_id(), 1, stm().map_key(Some(key())), 0);
    assert_eq!(controller.command(&c, 0).status, 0);
    let begin = Command {
        target_stm_boot: L4::new(controller.boot_id()),
        client_epoch: L4::new(1),
        command_id: L4::new(2),
        operation: 2,
        expected_generation: L4::new(0),
        data: heapless::Vec::from_slice(&[0]).unwrap(),
    };
    let result = controller.command(&begin, 10);
    assert_eq!(result.status, 0);
    assert_eq!(result.data.len(), 8);
    assert!(controller.run.is_some());
    let flash = controller.journal.into_flash();
    let mut restarted = Controller::boot(flash).unwrap();
    let mut retry = begin;
    retry.target_stm_boot = L4::new(restarted.boot_id());
    assert_eq!(restarted.command(&retry, 20).status, 5);
    assert!(restarted.run.is_none());
}

#[test]
fn usb_ui_reducer_preserves_saved_settings_and_rejects_unknown_controls() {
    let mut settings = sparkle();
    for (key, value) in [
        ("ui.mode", "Compass"),
        ("ui.brightness_percent", "50"),
        ("ui.map_range_m", "2000"),
        ("ui.blanked", "true"),
        ("ui.selected_peer_id", "8"),
        ("pattern.preset", "3"),
        ("pattern.cycle_ms", "16000"),
    ] {
        assert!(settings.set_value(key, value));
    }
    assert_eq!(settings.mode, 1);
    assert_eq!(settings.brightness, 50);
    assert_eq!(settings.range, 4);
    assert!(settings.blanked);
    assert_eq!(settings.selected, Some(L2::new(8)));
    let bytes = encode_record(&settings).unwrap();
    let restored: SparkleRecord = decode_record(&bytes).unwrap();
    assert_eq!(settings, restored);
    assert!(restored.valid());
    for (key, value) in [
        ("button.mode", "short"),
        ("ui.mode", "Clock"),
        ("ui.brightness_percent", "0"),
        ("ui.map_range_m", "999"),
        ("pattern.preset", "5"),
        ("ui.selected_peer_id", "65535"),
    ] {
        assert!(!settings.set_value(key, value));
    }
}

#[test]
fn mounted_shared_path_and_calibration_intent_preserve_output_contracts() {
    use crate::amulet::{calibration_frame, path_index};
    use palette::LinSrgb;
    let mut settings = sparkle();
    settings.rotation = L2::new(9000);
    settings.halo_clockwise = false;
    assert_eq!(path_index(0, &settings), 0);
    assert_eq!(path_index(256, &settings), 272);
    assert_eq!(path_index(257, &settings), 271);
    for (start, end) in [(256, 320), (320, 404), (404, 494)] {
        let mut visited = [false; 494];
        for i in start..end {
            let j = path_index(i, &settings);
            assert!((start..end).contains(&j));
            assert!(!visited[j]);
            visited[j] = true;
        }
    }
    let mut frame = [LinSrgb::new(0.8, 0.4, 0.2); 494];
    calibration_frame(&settings, true, false, &mut frame);
    assert!(
        frame
            .iter()
            .all(|p| (p.red - 0.05).abs() < 1e-6 && (p.green - 0.025).abs() < 1e-6)
    );
    calibration_frame(&settings, false, true, &mut frame);
    assert!(frame.iter().all(|p| *p == LinSrgb::new(0.25, 0.25, 0.25)));
    settings.blanked = true;
    calibration_frame(&settings, false, true, &mut frame);
    assert!(frame.iter().all(|p| *p == LinSrgb::new(0.0, 0.0, 0.0)));
}

#[test]
fn amulet_magnetic_north_survives_gps_loss_and_ring_overlap_keeps_identity() {
    use palette::LinSrgb;
    let mut settings = sparkle();
    settings.mode = 1;
    let mut state = StateSnapshot {
        boot: L4::new(1),
        sequence: L4::new(1),
        ..Default::default()
    };
    state.heading.quality = 3;
    let mut renderer = crate::amulet::Renderer::default();
    let mut frame = [LinSrgb::new(0.0, 0.0, 0.0); 494];
    renderer.render(&settings, Some((&state, 0)), 0, 0.0, false, &mut frame);
    for index in [256, 320, 404] {
        assert!((frame[index].red - 0.05).abs() < 1e-6);
        assert!((frame[index].green - 0.0175).abs() < 1e-6);
        assert_eq!(frame[index].blue, 0.0);
    }
    state.heading.quality = 4;
    state.local = Position {
        flags: L2::new(5),
        accuracy: L2::new(10),
        ..Default::default()
    };
    state
        .peers
        .push(Peer {
            id: L2::new(2),
            origin_boot: L4::new(1),
            sequence: L4::new(1),
            position: Position {
                lat: L4::new(10000),
                flags: L2::new(5),
                accuracy: L2::new(10),
                ..Default::default()
            },
            health: L2::new(5),
            hop: 1,
            rssi: L2::new(0),
            snr: 0,
            color: 1,
        })
        .unwrap();
    renderer.render(&settings, Some((&state, 0)), 0, 0.0, false, &mut frame);
    for index in [256, 320, 404] {
        assert_eq!(frame[index], LinSrgb::new(0.0875, 0.0875, 0.0875));
    }
    // Refresh heading while the common schedule advances to the peer's slot.
    renderer.render(&settings, Some((&state, 300)), 300, 0.0, false, &mut frame);
    for index in [256, 320, 404] {
        assert_eq!(frame[index], LinSrgb::new(0.0, 0.05, 0.125));
    }
}
