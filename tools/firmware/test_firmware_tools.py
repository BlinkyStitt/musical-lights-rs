"""Host-only codec, fitting, and interrupted-console regression checks."""

import binascii
import io
import json
import struct
import unittest

import numpy as np
from calibrate_sensors import GRAVITY, coefficient_record, fit_magnetometer
from codec import decode_frame, public_stm
from provision import Console


class FirmwareToolsTests(unittest.TestCase):
    def test_independent_board_fixture(self):
        data = decode_frame(bytes.fromhex("0301040201010102020101010418887700"))
        self.assertEqual(data, bytes([1, 4, 0]) + struct.pack("<IIH", 1, 2, 0x1800))
        with self.assertRaises(ValueError):
            decode_frame(bytes.fromhex("020403265600"))

    def test_console_events_do_not_consume_the_command_result(self):
        class Transport:
            def __init__(self):
                self.written = bytearray()
                self.lines = io.BytesIO(
                    b'log: boot\n{"event":"calibration","wire":"AA=="}\n{"ok":true}\n'
                )

            def write(self, data):
                self.written.extend(data)

            def readline(self, size):
                return self.lines.readline(size)

        serial = Transport()
        events = []
        self.assertEqual(Console(serial, events.append).request("status"), {"ok": True})
        self.assertEqual(serial.written, b"status\n")
        self.assertEqual(len(events), 1)

    def test_public_one_device_record_has_no_secret_or_trailing_bytes(self):
        body = (
            struct.pack("<HIHIIBI", 1, 1, 1, 0x01020304, 1, 1, 1)
            + bytes([1])
            + struct.pack("<HB", 1, 0)
        )
        body += struct.pack("<HIBHIHH", 1, 5000, 0, 1, 1, 1, 0) + bytes([0])
        record = body + struct.pack("<I", binascii.crc32(body))
        self.assertEqual(len(record), 47)
        settings = public_stm(record)
        self.assertTrue(settings["key_present"])
        self.assertNotIn("key", settings)
        with self.assertRaises(ValueError):
            public_stm(record + b"\0")

    def test_ellipsoid_fit_uses_held_out_samples_and_rejects_poor_coverage(self):
        rng = np.random.default_rng(731)
        unit = rng.normal(size=(2400, 3))
        unit /= np.linalg.norm(unit, axis=1)[:, None]
        distortion = np.array([[1.1, 0.03, 0], [0.03, 0.9, 0.02], [0, 0.02, 1.0]])
        samples = unit @ distortion.T * 50 + [5, -7, 2]
        bias, matrix, field, rms, maximum, bins = fit_magnetometer(samples)
        np.testing.assert_allclose(bias, [5, -7, 2], atol=1e-5)
        self.assertLess(rms, 1e-5)
        self.assertLess(maximum, 1e-5)
        self.assertTrue(all(n >= 12 for n in bins))
        self.assertLess(np.linalg.cond(matrix), 4)
        self.assertGreater(field, 15)
        with self.assertRaises(ValueError):
            fit_magnetometer(samples[:20])
        with self.assertRaises(ValueError):
            fit_magnetometer(np.ones((1000, 3)))

    def test_coefficient_record_contains_native_si_calibration_and_its_crc(self):
        rng = np.random.default_rng(179)
        unit = rng.normal(size=(2400, 3))
        unit /= np.linalg.norm(unit, axis=1)[:, None]
        rows = []
        for mag in unit * 50 + [4, -3, 2]:
            rows.append(
                dict(zip(("mx", "my", "mz"), mag)) | {"valid": 4, "pose": "rotate"}
            )
        for axis, letter in enumerate("xyz"):
            for sign in [-1, 1]:
                accel = np.array([0.1, -0.2, 0.3])
                accel[axis] += sign * GRAVITY
                for _ in range(120):
                    rows.append(
                        dict(
                            zip(
                                ("ax", "ay", "az", "gx", "gy", "gz"),
                                [*accel, 0.01, 0.02, -0.03],
                            )
                        )
                        | {"valid": 3, "pose": ("+" if sign == 1 else "-") + letter}
                    )
        record, report = coefficient_record(rows, 1, 1, 1)
        self.assertEqual(len(record), 120)
        self.assertEqual(
            binascii.crc32(record[:-4]), int.from_bytes(record[-4:], "little")
        )
        self.assertEqual(
            struct.unpack_from("<HHIIIh", record), (1, 1, 1, 1, 2400, -32768)
        )
        self.assertIn("Pending", report["fixture_acceptance"])
        json.dumps(report)


if __name__ == "__main__":
    unittest.main()
