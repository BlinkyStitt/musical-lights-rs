"""Execute the checkout-independent CI probe with deterministic transfer failures."""

import contextlib
import io
import json
import socket
import textwrap
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

WORKFLOW = (
    Path(__file__).resolve().parents[2] / ".github/workflows/gpu-runner-network.yml"
)


class GpuNetworkTests(unittest.TestCase):
    def setUp(self):
        # Loading the actual heredoc keeps the actionless probe testable without
        # adding checkout, a package install or a generated copy to its bootstrap.
        text = WORKFLOW.read_text()
        source = text.split("python3 - <<'PY'\n", 1)[1].rsplit("          PY", 1)[0]
        self.probe = types.ModuleType("gpu_network_probe")
        exec(  # noqa: S102 - execute the trusted repository workflow under test
            compile(textwrap.dedent(source), str(WORKFLOW), "exec"), vars(self.probe)
        )
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))

    def rows(self):
        return [json.loads(line) for line in self.output.getvalue().splitlines()]

    def transfer(self, *, error=None, body=b"archive", status=200):
        response = Mock()
        response.status = status
        response.read.return_value = body
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)

        def request(url, timeout):
            self.assertEqual(url, self.probe.ARCHIVE)
            self.assertEqual(timeout, 30)
            self.probe.socket.getaddrinfo("codeload.github.com", 443)
            if error:
                raise error
            return response

        return request

    def test_success_retains_native_resolution_and_records_complete_transfer(self):
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.1", 443))]
        with (
            patch.object(socket, "getaddrinfo", return_value=addresses) as lookup,
            patch.object(
                self.probe.urllib.request, "urlopen", side_effect=self.transfer()
            ) as request,
        ):
            self.probe.capture()
            self.assertIs(socket.getaddrinfo, lookup)
        lookup.assert_called_once_with("codeload.github.com", 443)
        self.assertEqual(request.call_count, 1)
        rows = self.rows()
        self.assertEqual(rows[0]["event"], "request-start")
        self.assertIn("/etc/resolv.conf", rows[0]["native"])
        self.assertIn("/proc/self/status", rows[0]["native"])
        success = next(row for row in rows if row["event"] == "request-success")
        self.assertEqual(success["bytes"], 7)
        self.assertEqual(len(success["sha256"]), 64)
        self.assertEqual(rows[-1]["event"], "request-end")

    def test_dns_failure_preserves_errno_and_fails_without_retry(self):
        failure = socket.gaierror(socket.EAI_AGAIN, "private error details")
        with (
            patch.object(socket, "getaddrinfo", side_effect=failure) as lookup,
            patch.object(
                self.probe.urllib.request, "urlopen", side_effect=self.transfer()
            ) as request,
        ):
            with self.assertRaises(socket.gaierror) as caught:
                self.probe.capture()
            self.assertIs(caught.exception, failure)
            self.assertIs(socket.getaddrinfo, lookup)
        self.assertEqual(lookup.call_count, 1)
        self.assertEqual(request.call_count, 1)
        rows = self.rows()
        failure_row = next(row for row in rows if row["event"] == "lookup-error")
        self.assertEqual(failure_row["errno"], socket.EAI_AGAIN)
        self.assertIn("/proc/net/snmp", failure_row["native"])
        self.assertNotIn("private error details", self.output.getvalue())
        self.assertNotIn("request-success", [row["event"] for row in rows])
        self.assertEqual(rows[-1]["event"], "request-end")

    def test_transfer_failure_after_resolution_still_fails(self):
        failure = TimeoutError("private transfer details")
        with (
            patch.object(socket, "getaddrinfo", return_value=[]),
            patch.object(
                self.probe.urllib.request,
                "urlopen",
                side_effect=self.transfer(error=failure),
            ) as request,
            self.assertRaises(TimeoutError),
        ):
            self.probe.capture()
        self.assertEqual(request.call_count, 1)
        self.assertNotIn("private transfer details", self.output.getvalue())
        self.assertIn("request-error", [row["event"] for row in self.rows()])

    def test_native_progress_is_emitted_during_a_blocked_lookup(self):
        sampled = threading.Event()
        emit = self.probe.emit

        def observe(event, **fields):
            emit(event, **fields)
            if event == "request-progress":
                sampled.set()

        def lookup(*args, **kwargs):
            self.assertTrue(sampled.wait(5), "No native evidence during lookup")
            return []

        with (
            patch.object(socket, "getaddrinfo", side_effect=lookup),
            patch.object(self.probe, "emit", side_effect=observe),
            patch.object(
                self.probe.urllib.request, "urlopen", side_effect=self.transfer()
            ),
        ):
            self.probe.capture()
        events = [row["event"] for row in self.rows()]
        self.assertLess(events.index("lookup-start"), events.index("request-progress"))
        self.assertLess(events.index("request-progress"), events.index("lookup-end"))

    def test_missing_or_partial_archive_is_not_success(self):
        for body, status in (
            (b"", 200),
            (b"partial", 206),
            (b"x" * (8 * 1024 * 1024 + 1), 200),
        ):
            with (
                self.subTest(status=status, size=len(body)),
                patch.object(socket, "getaddrinfo", return_value=[]),
                patch.object(
                    self.probe.urllib.request,
                    "urlopen",
                    side_effect=self.transfer(body=body, status=status),
                ),
                self.assertRaises(ValueError),
            ):
                self.probe.capture()

    def test_missing_native_evidence_is_explicit(self):
        with (
            patch.object(Path, "iterdir", side_effect=PermissionError(13, "denied")),
            patch("builtins.open", side_effect=PermissionError(13, "denied")),
        ):
            state = self.probe.native_state()
        self.assertEqual(state["/proc/self/task"]["errno"], 13)
        self.assertEqual(state["/etc/resolv.conf"]["errno"], 13)


if __name__ == "__main__":
    unittest.main()
