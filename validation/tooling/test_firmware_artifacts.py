"""Check firmware image bounds and the published file inventory."""

import hashlib
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ci
import firmware_artifacts as firmware


def partition(offset=0x10000, size=0x100000, kind=0):
    return struct.pack("<HBBII16sI", 0x50AA, kind, 0, offset, size, b"factory", 0)


class FirmwareArtifactTests(unittest.TestCase):
    def test_application_partition_rejects_ambiguous_or_unsupported_layouts(self):
        self.assertEqual(
            firmware.application_partition(
                partition(kind=1) + partition() + bytes([255] * 32)
            ),
            (0x10000, 0x100000),
        )
        for invalid in [
            b"",
            partition()[:-1],
            partition() * 2,
            partition(kind=1),
            partition(offset=0),
            partition(size=0),
            partition(size=0x200000),
            bytes(32),
        ]:
            with self.assertRaises(ValueError):
                firmware.application_partition(invalid)

    def test_inventory_uses_actual_binary_bytes_and_excludes_its_own_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "net.bin").write_bytes(b"firmware bytes")
            (root / "manifest.json").write_text("metadata")
            (root / "SHA256SUMS").write_text("checksums")
            expected = {
                "net.bin": {
                    "bytes": 14,
                    "sha256": hashlib.sha256(b"firmware bytes").hexdigest(),
                }
            }
            self.assertEqual(firmware.inventory(root), expected)
            (root / "net.bin").write_bytes(b"changed")
            self.assertNotEqual(firmware.inventory(root), expected)

    def test_dirty_source_cannot_produce_an_artifact(self):
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(firmware, "output", return_value=" M source.rs"),
        ):
            destination = Path(temp) / "artifact"
            with self.assertRaises(ValueError):
                firmware.pack("stm32", destination)
            self.assertFalse(destination.exists())

    def test_packaging_change_selects_firmware_builds(self):
        for package in ("musical-stm32", "musical-adafruit-sparkle-idf"):
            self.assertTrue(
                ci.affected(["validation/firmware_artifacts.py"], package, "firmware")
            )
        self.assertFalse(
            ci.affected(
                ["validation/firmware_artifacts.py"], "musical-terminal", "other-apps"
            )
        )
