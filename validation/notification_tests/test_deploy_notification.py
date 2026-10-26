import importlib.util
from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "deploy_notification", Path(__file__).parents[1] / "deploy_notification.py"
)
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class NotificationTests(unittest.TestCase):
    def result(self, *, deployed=True, failed=None, cancelled=False, stale=False):
        jobs: dict[str, dict] = {
            name: {"result": "success"}
            for name in ("core", "rust", "web", "loudness-reference", "esp", "pages")
        }
        jobs["pages"]["outputs"] = {
            "deployed": str(deployed).lower(),
            "page_url": "https://lights.example/" if deployed else "",
        }
        if failed:
            jobs[failed]["result"] = "failure"
        if cancelled:
            jobs["core"]["result"] = "cancelled"
        return module.notification(
            jobs,
            "a" * 40,
            "b" * 40 if stale else "a" * 40,
            "owner/lights",
            "https://github.com/run/1",
        )

    def test_success_links_to_actual_site(self):
        result = self.result()
        self.assertEqual(
            result,
            {
                "title": "Musical Lights deployed",
                "message": "Site: deployed\nCommit: https://github.com/owner/lights/commit/"
                + "a" * 40
                + "\nWebsite: https://lights.example/\n"
                "Workflow: https://github.com/run/1",
                "priority": 3,
                "tags": ["white_check_mark"],
                "click": "https://lights.example/",
            },
        )

    def test_validation_and_deployment_failures(self):
        for failed in ("core", "web", "pages"):
            with self.subTest(failed=failed):
                result = self.result(deployed=False, failed=failed)
                self.assertEqual(result["priority"], 4)
                self.assertEqual(result["click"], "https://github.com/run/1")
                self.assertIn("Site: not deployed", result["message"])
                self.assertIn("Failed jobs: " + failed, result["message"])

    def test_mixed_result_reports_deployed_site_and_failed_validation(self):
        result = self.result(failed="esp")
        self.assertEqual(result["title"], "Musical Lights deployed; validation failed")
        self.assertIn("Website: https://lights.example/", result["message"])

    def test_skips_cancellation_and_superseded_non_deployments(self):
        for kwargs in (
            {"cancelled": True},
            {"deployed": False},
            {"deployed": False, "failed": "web", "stale": True},
        ):
            with self.subTest(kwargs=kwargs):
                self.assertIsNone(self.result(**kwargs))
        self.assertEqual(self.result(stale=True)["title"], "Musical Lights deployed")

    def test_delivery_failure_is_visible_without_failing_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / "summary"
            env = {
                "JOB_RESULTS": json.dumps({"pages": {"result": "failure"}}),
                "GITHUB_SHA": "a",
                "LATEST_SHA": "a",
                "GITHUB_REPOSITORY": "x/y",
                "GITHUB_SERVER_URL": "https://github.com",
                "GITHUB_RUN_ID": "1",
                "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_STEP_SUMMARY": str(summary),
                "NTFY_URL": "https://fixture.example",
                "NTFY_TOPIC": "deploy",
                "NTFY_TOKEN": "synthetic",
            }
            output = StringIO()
            with (
                redirect_stdout(output),
                patch.dict(os.environ, env),
                patch.object(
                    module.urllib.request,
                    "urlopen",
                    side_effect=OSError("private detail"),
                ) as send,
            ):
                module.main()
            self.assertEqual(
                output.getvalue(),
                "::warning::Deployment notification failed; deployment results are unchanged.\n",
            )
            self.assertEqual(send.call_args.kwargs["timeout"], 15)
            self.assertEqual(
                send.call_args.args[0].get_header("Authorization"), "Bearer synthetic"
            )
            self.assertEqual(
                summary.read_text(),
                "Deployment notification failed; deployment results are unchanged.\n",
            )
