"""Installer failures must be bounded and must not publish partial binaries."""

from __future__ import annotations

import sys
import tempfile
import unittest
from email.message import Message
from io import BytesIO
from pathlib import Path
from unittest.mock import call, patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from install_tools import download


class Response(BytesIO):
    def __init__(self, data: bytes, length: int | None = None):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data) if length is None else length)}


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.destination = Path(self.directory.name) / "tool"
        self.destination.write_bytes(b"previous binary")
        self.url = "https://example.invalid/pinned-tool"

    def http_error(self, status):
        return HTTPError(self.url, status, "fixture error", Message(), None)

    def test_transient_errors_retry_then_atomically_replace(self):
        for error in [
            self.http_error(500),
            self.http_error(429),
            URLError("offline"),
            TimeoutError(),
        ]:
            with self.subTest(error=error):
                self.destination.write_bytes(b"previous binary")

                with (
                    patch(
                        "install_tools.urlopen",
                        side_effect=[error, Response(b"complete binary")],
                    ) as opened,
                    patch("install_tools.time.sleep") as sleep,
                ):
                    download(self.url, self.destination)
                self.assertEqual(self.destination.read_bytes(), b"complete binary")
                self.assertEqual(opened.call_count, 2)
                self.assertEqual(opened.call_args, call(self.url, timeout=30))
                sleep.assert_called_once_with(1)
                self.assertEqual(
                    list(Path(self.directory.name).iterdir()), [self.destination]
                )

    def test_permanent_http_failure_does_not_retry_or_replace(self):
        with (
            patch("install_tools.urlopen", side_effect=self.http_error(404)) as opened,
            patch("install_tools.time.sleep") as sleep,
            self.assertRaises(HTTPError),
        ):
            download(self.url, self.destination)
        opened.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(self.destination.read_bytes(), b"previous binary")

    def test_repeated_server_failure_stops_after_four_attempts(self):
        with (
            patch("install_tools.urlopen", side_effect=self.http_error(503)) as opened,
            patch("install_tools.time.sleep") as sleep,
            self.assertRaises(HTTPError),
        ):
            download(self.url, self.destination)
        self.assertEqual(opened.call_count, 4)
        self.assertEqual(sleep.call_args_list, [call(1), call(2), call(4)])
        self.assertEqual(self.destination.read_bytes(), b"previous binary")

    def test_truncated_response_never_replaces_existing_binary(self):
        with (
            patch(
                "install_tools.urlopen",
                side_effect=lambda *a, **kw: Response(b"partial", length=100),
            ),
            patch("install_tools.time.sleep"),
            self.assertRaisesRegex(URLError, "Incomplete download"),
        ):
            download(self.url, self.destination)
        self.assertEqual(self.destination.read_bytes(), b"previous binary")
        self.assertEqual(list(Path(self.directory.name).iterdir()), [self.destination])


if __name__ == "__main__":
    unittest.main()
