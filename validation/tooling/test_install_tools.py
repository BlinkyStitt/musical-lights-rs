"""Installer failures must be bounded and must not publish partial binaries."""

from __future__ import annotations

import sys
import tarfile
import tempfile
import unittest
from email.message import Message
from io import BytesIO
from pathlib import Path
from unittest.mock import call, patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_tools
from install_tools import download


class Response(BytesIO):
    def __init__(self, data: bytes, length: int | None = None):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data) if length is None else length)}


class CiToolsTests(unittest.TestCase):
    def test_ci_installs_executable_uv_with_the_workflow_checker(self):
        for system, machine, target in [
            ("Linux", "x86_64", "x86_64-unknown-linux-gnu"),
            ("Linux", "aarch64", "aarch64-unknown-linux-gnu"),
            ("Darwin", "x86_64", "x86_64-apple-darwin"),
            ("Darwin", "arm64", "aarch64-apple-darwin"),
        ]:
            with (
                self.subTest(system=system, machine=machine),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)

                def archive(url, destination):
                    binary = "uv" if "/astral-sh/uv/" in url else "actionlint"
                    data = f"#!/bin/sh\necho {binary}\n".encode()
                    with tarfile.open(destination, "w:gz") as package:
                        member = tarfile.TarInfo(f"release/{binary}")
                        member.size = len(data)
                        package.addfile(member, BytesIO(data))

                with (
                    patch.object(install_tools, "ROOT", root),
                    patch.object(sys, "argv", ["install_tools.py", "ci"]),
                    patch("install_tools.platform.system", return_value=system),
                    patch("install_tools.platform.machine", return_value=machine),
                    patch("install_tools.download", side_effect=archive) as fetched,
                ):
                    install_tools.main()
                self.assertEqual(fetched.call_count, 2)
                self.assertEqual(
                    fetched.call_args.args[0],
                    f"https://github.com/astral-sh/uv/releases/download/0.10.5/uv-{target}.tar.gz",
                )
                for binary in ("actionlint", "uv"):
                    installed = root / ".tools/bin" / binary
                    self.assertEqual(installed.stat().st_mode & 0o777, 0o755)
                    self.assertEqual(
                        installed.read_text(), f"#!/bin/sh\necho {binary}\n"
                    )

    def test_uv_installation_failure_is_not_ignored(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(install_tools, "ROOT", Path(directory)),
            patch.object(sys, "argv", ["install_tools.py", "ci"]),
            patch(
                "install_tools.install_archive",
                side_effect=[None, URLError("uv unavailable")],
            ),
            self.assertRaisesRegex(URLError, "uv unavailable"),
        ):
            install_tools.main()


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
