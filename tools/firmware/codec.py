"""Approved six-variant board frames and canonical public records."""

import base64
import binascii
import math
import struct


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x8408 if crc & 1 else 0)
    return crc ^ 0xFFFF


def decode_frame(wire):
    if len(wire) > 512 or not wire or wire[-1] != 0:
        raise ValueError("Invalid board frame length or delimiter")
    data = bytearray()
    cursor = 0
    body = wire[:-1]
    while cursor < len(body):
        code = body[cursor]
        cursor += 1
        if code == 0 or cursor + code - 1 > len(body):
            raise ValueError("Invalid COBS frame")
        data.extend(body[cursor : cursor + code - 1])
        cursor += code - 1
        if code < 255 and cursor < len(body):
            data.append(0)
    if len(data) < 4 or crc16(data[:-2]) != int.from_bytes(data[-2:], "little"):
        raise ValueError("Invalid board CRC")
    if data[0] != 1 or data[1] > 5:
        raise ValueError("Unsupported board schema")
    return bytes(data[:-2])


def calibration_event(event):
    data = decode_frame(base64.b64decode(event["wire"], validate=True))
    if data[1] != 5 or len(data) < 23:
        raise ValueError("Expected CalibrationBatch")
    (boot,) = struct.unpack_from("<I", data, 2)
    run = data[6:14]
    sequence, overrun = struct.unpack_from("<II", data, 14)
    count = data[22]
    if (
        not 1 <= count <= 8
        or len(data) != 23 + 41 * count
        or not boot
        or not sequence
        or overrun
    ):
        raise ValueError("Calibration stream has invalid length or lost samples")
    rows = []
    for offset in range(23, len(data), 41):
        captured, valid, *vectors = struct.unpack_from("<IB9f", data, offset)
        if not valid or valid & ~7 or not all(math.isfinite(v) for v in vectors):
            raise ValueError("Invalid raw sensor sample")
        for component in range(3):
            if not valid & (1 << component) and data[
                offset + 5 + component * 12 : offset + 17 + component * 12
            ] != bytes(12):
                raise ValueError("Absent vector must contain positive zero")
        rows.append(
            {
                "captured_ms": captured,
                "valid": valid,
                **dict(
                    zip(("ax", "ay", "az", "gx", "gy", "gz", "mx", "my", "mz"), vectors)
                ),
            }
        )
    return boot, run, sequence, rows


def public_stm(record):
    if len(record) < 47 or binascii.crc32(record[:-4]) != int.from_bytes(
        record[-4:], "little"
    ):
        raise ValueError("Invalid public settings CRC")
    schema, generation, device, group, key_id, present, revision = struct.unpack_from(
        "<HIHIIBI", record
    )
    if schema != 1 or present not in (0, 1):
        raise ValueError("Invalid settings schema")
    cursor = 21
    count = record[cursor]
    cursor += 1
    if not 1 <= count <= 8:
        raise ValueError("Invalid roster count")
    roster = []
    for _ in range(count):
        peer, color = struct.unpack_from("<HB", record, cursor)
        roster.append({"id": peer, "color": color})
        cursor += 3
    radio, interval, relay, sensor, mount, gps, battery = struct.unpack_from(
        "<HIBHIHH", record, cursor
    )
    cursor += 17
    tag = record[cursor]
    cursor += 1
    if tag not in (0, 1):
        raise ValueError("Invalid coefficient tag")
    calibration = record[cursor : cursor + 120] if tag else None
    cursor += 120 if tag else 0
    if cursor + 4 != len(record):
        raise ValueError("Trailing settings data")
    return {
        "generation": generation,
        "device_id": device,
        "group_id": group,
        "key_id": key_id,
        "key_present": bool(present),
        "roster_revision": revision,
        "roster": roster,
        "radio_profile": radio,
        "interval_ms": interval,
        "relay_enabled": bool(relay),
        "sensor_profile": sensor,
        "mount_revision": mount,
        "gps_profile": gps,
        "battery_profile": battery,
        "calibration_revision": int.from_bytes(calibration[10:14], "little")
        if calibration
        else 0,
    }
