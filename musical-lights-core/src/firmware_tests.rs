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
fn provisioned_gps_timing_acquires_from_parsed_epochs_and_bounds_pps_association() {
    let timing = GpsTiming::parse("0,100,400,10,80").unwrap();
    let mut parser = GpsParser::default();
    let mut clock = UtcClock::default();
    let mut unknown = UtcClock::default();
    for second in 0..5 {
        let pps = second * 1000;
        assert!(
            parser
                .push(
                    &nmea(&std::format!(
                        "GPRMC,1200{second:02}.000,A,3746.4940,N,12225.1640,W,0,0,121026,,,A"
                    )),
                    pps + 100
                )
                .is_none()
        );
        let fix = parser
            .push(
                &nmea(&std::format!(
                    "GPGGA,1200{second:02}.000,3746.4940,N,12225.1640,W,1,08,0.9,10,M,30,M,,"
                )),
                pps + 300,
            )
            .unwrap();
        assert_eq!(
            clock.accept(crate::gps::pps_anchor(fix, pps, Some(timing)).unwrap()),
            second == 4
        );
        assert!(!unknown.accept(crate::gps::pps_anchor(fix, pps, None).unwrap()));
        for (delay, accepted) in [
            (99, false),
            (100, true),
            (400, true),
            (401, false),
            (1000, false),
        ] {
            let mut delayed = fix;
            delayed.captured_ms = pps + delay;
            assert_eq!(
                crate::gps::pps_anchor(delayed, pps, Some(timing)).is_some(),
                accepted
            );
        }
        for offset in [-1000i32, 0, 1000] {
            let mut shifted = timing;
            shifted.epoch_offset_ms = L4::new(offset as u32);
            assert_eq!(
                crate::gps::pps_anchor(fix, pps, Some(shifted))
                    .unwrap()
                    .utc_ms,
                fix.utc_ms.checked_add_signed(offset as i64).unwrap()
            );
        }
        let mut invalid = fix;
        invalid.time_valid = false;
        assert!(crate::gps::pps_anchor(invalid, pps, Some(timing)).is_none());
        invalid = fix;
        invalid.utc_ms += 1;
        assert!(crate::gps::pps_anchor(invalid, pps, Some(timing)).is_none());
        assert!(crate::gps::pps_anchor(fix, fix.captured_ms + 1, Some(timing)).is_none());
    }
    assert_eq!(clock.state(), ClockState::Locked);
    assert_eq!(unknown.state(), ClockState::Acquiring);
    assert_eq!(clock.utc(4000), Some((EPOCH + 4000, 10)));
    clock.update(8000);
    assert_eq!(clock.state(), ClockState::Holdover);
    assert_eq!(clock.utc(14000), Some((EPOCH + 14000, 11)));
}
#[test]
fn gps_timing_rejects_incomplete_unbounded_and_unsupported_profiles() {
    for invalid in [
        "",
        "0,100,400,10",
        "0,100,400,10,80,1",
        "1,100,400,10,80",
        "0,401,400,10,80",
        "0,0,1000,10,80",
        "0,0,999,0,80",
        "0,0,999,51,80",
        "0,0,999,10,0",
        "0,0,999,10,101",
        "0,-1,400,10,80",
    ] {
        assert!(GpsTiming::parse(invalid).is_none(), "{invalid}");
    }
    assert!(GpsTiming::parse("-1000,0,999,1,100").is_some());
    assert!(GpsTiming::parse("1000,999,999,50,1").is_some());
    let mut settings = stm();
    settings.schema = L2::new(1);
    assert!(!settings.valid());
    settings.schema = L2::new(2);
    let mut timing = GpsTiming::parse("0,100,400,10,80").unwrap();
    timing.drift_ppm = L2::new(101);
    settings.gps_timing = Some(timing);
    assert!(!settings.valid());
}
#[test]
fn locked_clock_does_not_certify_a_rejected_new_measurement_epoch() {
    use crate::gps::{Fix, verify_epoch};
    let timing = GpsTiming::parse("0,100,400,10,80").unwrap();
    let mut clock = UtcClock::default();
    let mut fix = Fix {
        latitude_e7: 0,
        longitude_e7: 0,
        utc_ms: EPOCH,
        captured_ms: 100,
        valid: true,
        time_valid: true,
        altitude_m: None,
        hdop: None,
    };
    for second in 0..5 {
        fix.utc_ms = EPOCH + second * 1000;
        fix.captured_ms = second * 1000 + 100;
        assert_eq!(
            verify_epoch(&mut clock, fix, Some(second * 1000), Some(timing)),
            second == 4
        );
    }
    fix.utc_ms += 60_000;
    fix.captured_ms = 5500; // Outside the installed delay bound.
    assert!(!verify_epoch(&mut clock, fix, Some(5000), Some(timing)));
    assert_eq!(clock.state(), ClockState::Locked);
    assert!(clock.utc(5500).is_some()); // The old anchor still supports holdover.
    assert!(!verify_epoch(&mut clock, fix, None, Some(timing)));
    fix.captured_ms = 6100; // A discontinuity inside the window forces acquisition.
    assert!(!verify_epoch(&mut clock, fix, Some(6000), Some(timing)));
    assert_eq!(clock.state(), ClockState::Acquiring);
}
#[test]
fn gps_timing_public_record_matches_independent_python_fixture() {
    let mut settings = stm();
    settings.roster.truncate(1);
    settings.gps_timing = GpsTiming::parse("-1000,100,400,10,80");
    let public = settings.public_bytes().unwrap();
    // Python struct.pack + binascii.crc32, also decoded by the host-tool tests.
    assert_eq!(
        public.as_slice(),
        unhex(
            "020001000000010004030201010000000101000000010100000100881300000001000100000001000118fcffff640090010a005000000000c4908d66"
        )
    );
    let restored: StmRecord<u8> = decode_record(&public).unwrap();
    assert_eq!(restored.gps_timing, settings.gps_timing);
    assert!(restored.valid_common());
}
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
    let fixture = unhex("0303040201010102020101010418d27c00");
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
    for b in unhex("0301040201010102020101010418887700") {
        if let Some(r) = decoder.feed(b) {
            assert!(r.is_err());
        }
    } // Superseded version-1 heartbeat with a valid CRC.
    for b in unhex("03020402010101020201010104187f7900") {
        if let Some(r) = decoder.feed(b) {
            assert!(r.is_err());
        }
    } // Superseded version-2 heartbeat with a valid CRC.
}
#[test]
fn uart_complete_snapshot_and_commands_fit_the_512_byte_limit() {
    let mut snapshot = StateSnapshot {
        boot: L4::new(1),
        sequence: L4::new(1),
        roster_revision: L4::new(1),
        motion: Motion {
            acceleration: [L2::new((-500i16) as u16), L2::new(0), L2::new(866)],
            gravity: [L2::new((-500i16) as u16), L2::new(0), L2::new(866)],
            shake: L2::new(123),
            captured_at: L4::new(u32::MAX - 5),
            age: L2::new(25),
            quality: 1,
            calibration_revision: L4::new(0),
        },
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
                freshness_verified: false,
            })
            .unwrap();
    }
    let mut encoder = MessageEncoder::new();
    let frame = encoder.encode(&Message::StateSnapshot(snapshot)).unwrap();
    assert!(frame.len() <= 356);
    assert!(frame.len() * 20 * 10 < MESSAGE_BAUD_RATE as usize * 63 / 100);
    println!(
        "Full seven-peer motion snapshot: {} bytes at 20 Hz",
        frame.len()
    );
    // Independent Python fixed-width serialization, CRC-16 and COBS fixture.
    assert_eq!(
        frame,
        unhex(
            "0403010101010201010101010101010101010201010101010101010101010101010101010101010101010101010101010101010101030cfe010562030cfe010462037b06faffffff19020101010101010101010101010109ffffffffffffffff03e8030105ffffffff010101010101040807020201010102010101010101010101010101010101010101010101020104808001020302010101020101010101010101010101010101010101010101010201048080020204020101010201010101010101010101010101010101010101010102010480800302050201010102010101010101010101010101010101010101010101020104808004020602010101020101010101010101010101010101010101010101010201048080050207020101010201010101010101010101010101010101010101010102010480800602080201010102010101010101010101010101010101010101010101020104808007039ada00"
        )
    );
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
#[test]
fn receiver_freshness_survives_uart_without_relabeling_origin_health() {
    for trusted in [false, true] {
        for hop in [1, 2] {
            let mut network = Network::new(8, origin().group, roster(), false).unwrap();
            let mut report = origin();
            report.hop = hop;
            if hop == 2 {
                report.relay = 2;
            }
            network
                .receive(report, 0, trusted.then_some((report.utc_ms + 1000, 10)), 0)
                .unwrap();
            let peer = network.peers[0].unwrap().snapshot(100);
            assert_eq!(peer.freshness_verified, trusted);
            assert_eq!(peer.health.get(), report.flags);
            assert_eq!(peer.position.flags.get(), report.flags & 7);
            let mut snapshot = StateSnapshot {
                boot: L4::new(1),
                sequence: L4::new(1),
                slot: 7,
                count: 8,
                roster_revision: L4::new(1),
                ..Default::default()
            };
            snapshot.peers.push(peer).unwrap();
            let message = Message::StateSnapshot(snapshot);
            let mut encoder = MessageEncoder::new();
            let mut decoder = MessageDecoder::new();
            let decoded = encoder
                .encode(&message)
                .unwrap()
                .iter()
                .filter_map(|&b| decoder.feed(b))
                .next()
                .unwrap()
                .unwrap();
            assert_eq!(decoded, message);
            // Later clock availability does not change a report accepted without UTC.
            assert_eq!(
                network.receive(report, 200, Some((report.utc_ms + 1200, 10)), 0),
                Err(RadioError::Replay)
            );
            assert_eq!(
                network.peers[0].unwrap().snapshot(200).freshness_verified,
                trusted
            );
        }
    }
}
#[test]
fn amulet_unverified_or_stale_navigation_has_no_solid_target_arrow() {
    use palette::LinSrgb;
    let mut settings = sparkle();
    settings.mode = 1;
    settings.selected = Some(L2::new(2));
    let mut state = StateSnapshot {
        boot: L4::new(1),
        sequence: L4::new(1),
        ..Default::default()
    };
    state.heading.quality = 4;
    state.local.flags = L2::new(5);
    state.local.accuracy = L2::new(10);
    let mut peer = PeerState {
        report: origin(),
        received_ms: 0,
        age_at_receive: 0,
        verified: true,
    }
    .snapshot(0);
    peer.id = L2::new(2);
    peer.position.lat = L4::new(0);
    peer.position.lon = L4::new(10000);
    peer.position.accuracy = L2::new(10);
    peer.color = 1;
    state.peers.push(peer).unwrap();
    let mut frame = [LinSrgb::new(0.0, 0.0, 0.0); 494];
    for (verified, peer_age, local_age, arrow) in [
        (true, 15000, 15000, true),
        (false, 0, 0, false),
        (true, 15001, 0, false),
        (true, 0, 15001, false),
    ] {
        state.peers[0].freshness_verified = verified;
        state.peers[0].position.age = L4::new(peer_age);
        state.local.age = L4::new(local_age);
        let mut renderer = crate::amulet::Renderer::default();
        renderer.render(
            &settings,
            Some((&state, 2000)),
            2000,
            0.0,
            false,
            &mut frame,
        );
        assert_eq!(frame[..256].iter().any(|p| p.blue > 0.0), arrow);
    }
    settings.mode = 0;
    for (verified, now, peak) in [
        (true, 2000, 0.125),
        (false, 2000, 0.0375),
        (false, 2200, 0.0),
    ] {
        state.peers[0].freshness_verified = verified;
        state.peers[0].position.age = L4::new(0);
        state.local.age = L4::new(0);
        let mut renderer = crate::amulet::Renderer::default();
        renderer.render(&settings, Some((&state, now)), now, 0.0, false, &mut frame);
        let actual = frame[..256].iter().map(|p| p.blue).fold(0.0f32, f32::max);
        if peak == 0.0 {
            assert_eq!(actual, 0.0);
        } else {
            assert!(actual > 0.0 && actual <= peak + 1e-6);
        }
    }
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
        schema: L2::new(2),
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
        gps_timing: None,
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
fn gps_timing_and_command_outcome_recover_together_after_interrupted_writes() {
    let mut controller = Controller::boot(MemoryFlash::new()).unwrap();
    let initial = stm();
    let command = replace(
        controller.boot_id(),
        1,
        initial.clone().map_key(Some(key())),
        0,
    );
    assert_eq!(controller.command(&command, 0).status, 0);
    let mut measured = initial.clone();
    measured.generation = L4::new(2);
    measured.gps_timing = GpsTiming::parse("-1000,100,400,10,80");
    let command = replace(controller.boot_id(), 2, measured.clone().map_key(None), 1);
    let original = controller.journal.into_flash();
    for boundary in (0..=PAGE + 4).step_by(4) {
        let mut flash = original.clone();
        flash.remaining = Some(boundary);
        let mut controller = Controller {
            journal: Journal::open(flash).unwrap(),
            settings: Some(initial.clone()),
            run: None,
            storage_fault: false,
        };
        let applied = controller.command(&command, 1).status == 0;
        let mut flash = controller.journal.into_flash();
        flash.remaining = None;
        let mut recovered = Controller::boot(flash).unwrap();
        assert!(
            recovered.settings.as_ref() == Some(if applied { &measured } else { &initial }),
            "boundary {boundary}"
        );
        let mut retry = command.clone();
        retry.target_stm_boot = L4::new(recovered.boot_id());
        assert_eq!(
            recovered.command(&retry, 2).status,
            if applied { 1 } else { 0 }
        );
        assert!(recovered.settings.as_ref() == Some(&measured));
    }
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

pub(crate) fn coefficients() -> Coefficients {
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
                flags: L2::new(7),
                accuracy: L2::new(10),
                ..Default::default()
            },
            health: L2::new(7),
            hop: 1,
            rssi: L2::new(0),
            snr: 0,
            color: 1,
            freshness_verified: true,
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

#[test]
fn pps_anchor_uses_capture_time_across_wrap_and_rejects_stale_edges() {
    use crate::gps::pps_timestamp;
    assert_eq!(pps_timestamp(1_000_000, 1_012_345), Some(1_000_000));
    let now = (u32::MAX as u64) + 1001;
    assert_eq!(
        pps_timestamp(u32::MAX - 999, now),
        Some(u32::MAX as u64 - 999)
    );
    assert_eq!(pps_timestamp(500, now), Some(u32::MAX as u64 + 501));
    assert_eq!(pps_timestamp(1001, now), None); // Future edge, not a previous wrap.
    assert_eq!(pps_timestamp(5, 2_000_005), Some(5));
    assert_eq!(pps_timestamp(5, 2_000_006), None);
}

#[test]
fn motion_snapshot_validation_and_freshness_do_not_require_magnetic_heading() {
    let mut s = StateSnapshot {
        boot: L4::new(1),
        sequence: L4::new(1),
        slot: 255,
        ..Default::default()
    };
    let mut estimator = crate::pattern_motion::MotionEstimator::default();
    s.motion = estimator.update(
        [9.80665, 0.0, 0.0],
        false,
        None,
        crate::sensor_mount::ImuMounts::default(),
        u32::MAX as u64 + 10,
    );
    assert_eq!(s.motion.captured_at.get(), 9);
    assert_eq!(s.heading.quality, 0);
    assert!(Message::StateSnapshot(s.clone()).valid());
    let mut encoder = MessageEncoder::new();
    let wire = encoder.encode(&Message::StateSnapshot(s.clone())).unwrap();
    let mut decoder = MessageDecoder::new();
    let decoded = wire
        .iter()
        .filter_map(|b| decoder.feed(*b))
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(decoded, Message::StateSnapshot(s.clone()));
    for change in 0..4 {
        let mut bad = s.clone();
        match change {
            0 => bad.motion.quality = 3,
            1 => bad.motion.acceleration[0] = L2::new(8001),
            2 => bad.motion.shake = L2::new(16001),
            _ => bad.motion.calibration_revision = L4::new(1),
        }
        assert!(!Message::StateSnapshot(bad).valid());
    }
    s.motion.quality = 0;
    assert!(!Message::StateSnapshot(s).valid());
}
#[test]
fn amulet_patterns_use_motion_but_navigation_and_shared_sections_keep_their_contracts() {
    use palette::LinSrgb;
    let mut settings = sparkle();
    let mut s = StateSnapshot {
        boot: L4::new(1),
        sequence: L4::new(1),
        slot: 0,
        count: 8,
        roster_revision: L4::new(1),
        ..Default::default()
    };
    let mut estimator = crate::pattern_motion::MotionEstimator::default();
    s.motion = estimator.update(
        [9.80665, 0.0, 0.0],
        false,
        None,
        crate::sensor_mount::ImuMounts::default(),
        0,
    );
    let mut moving = [LinSrgb::new(0.0, 0.0, 0.0); 494];
    let mut neutral = moving;
    for preset in 0..=4 {
        settings.preset = preset;
        crate::amulet::Renderer::default().render(
            &settings,
            Some((&s, 0)),
            0,
            0.7,
            false,
            &mut moving,
        );
        let mut base = s.clone();
        base.motion = Motion::default();
        crate::amulet::Renderer::default().render(
            &settings,
            Some((&base, 0)),
            0,
            0.7,
            false,
            &mut neutral,
        );
        if preset == 3 {
            assert_eq!(moving, neutral);
        } else {
            assert_ne!(moving, neutral);
        }
        for (lo, hi) in [(0, 256), (256, 320), (320, 404), (404, 494)] {
            if preset != 3 {
                assert_ne!(&moving[lo..hi], &neutral[lo..hi]);
            }
        }
        let mut stale = s.clone();
        stale.motion.age = L2::new(101);
        crate::amulet::Renderer::default().render(
            &settings,
            Some((&stale, 0)),
            0,
            0.7,
            false,
            &mut moving,
        );
        assert_eq!(moving, neutral);
        s.motion.shake = L2::new(1500);
        crate::amulet::Renderer::default().render(
            &settings,
            Some((&s, 0)),
            0,
            0.7,
            false,
            &mut moving,
        );
        assert_ne!(moving, neutral);
        assert!(moving.iter().all(|c| {
            [c.red, c.green, c.blue]
                .iter()
                .all(|v| (0.0..=1.0).contains(v))
        }));
        s.motion.shake = L2::new(0);
    }
    for mode in 0..=1 {
        s.motion = estimator.update(
            [0.0, 9.80665, 0.0],
            false,
            None,
            crate::sensor_mount::ImuMounts::default(),
            200,
        );
        s.motion.shake = L2::new(1500);
        settings.mode = mode;
        crate::amulet::Renderer::default().render(
            &settings,
            Some((&s, 0)),
            0,
            0.0,
            false,
            &mut moving,
        );
        s.motion = Motion::default();
        crate::amulet::Renderer::default().render(
            &settings,
            Some((&s, 0)),
            0,
            0.0,
            false,
            &mut neutral,
        );
        assert_eq!(moving, neutral);
    }
}
