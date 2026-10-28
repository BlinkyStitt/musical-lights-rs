"""The remote browser gate accepts only complete evidence for the current commit."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ci
import ci_browser


class BrowserGateTests(unittest.TestCase):
    def setUp(self):
        self.repository = "owner/project"
        self.head = "a" * 40
        self.expected = {
            "source_tree": "tree",
            "workflow": "workflow",
            "runner_os": "Linux",
            "runner_arch": "X64",
        }
        self.ci_run = {
            "id": 42,
            "run_attempt": 1,
            "head_sha": self.head,
            "head_repository": {"full_name": self.repository},
            "event": "pull_request",
            "pull_requests": [{"number": 7}],
            "status": "completed",
            "conclusion": "success",
            "path": ".github/workflows/validate.yml",
        }
        self.jobs = [{"name": name, "conclusion": "success"} for name in ci.VALIDATORS]
        self.parent = self.head
        self.producer = self.repository
        self.source_tree = "tree"
        self.attempt = 1

    def read(self, repository, path):
        self.assertEqual(repository, self.repository)
        if "/jobs?" in path:
            return {"jobs": self.jobs}
        if path.startswith("git/commits/"):
            return {
                "tree": {"sha": self.source_tree},
                "parents": [{"sha": self.parent}],
            }
        self.fail(path)

    def fetch(self, repository, run, directory):
        self.assertEqual(repository, self.repository)
        self.assertEqual(run["artifact_name"], "validated-site-tree")
        for name in ci.PAYLOAD:
            path = directory / name / "build"
            path.parent.mkdir(parents=True)
            path.write_text("compiled")
        (directory / "inventory.json").write_text("{}")
        manifest = {
            "schema": 2,
            "inputs": self.expected,
            "producer_image": "ubuntu24",
            "run_id": str(self.ci_run["id"]),
            "run_attempt": self.attempt,
            "repository": self.repository,
            "head_repository": self.producer,
            "source_commit": "b" * 40,
            "files": ci.files(directory),
        }
        (directory / "provenance.json").write_text(json.dumps(manifest))

    def verify(self):
        ci_browser.verify_run(
            self.repository,
            self.ci_run,
            self.head,
            self.expected,
            self.read,
            self.fetch,
        )

    def test_complete_run_and_exact_source_pass(self):
        self.verify()

    def test_rejects_missing_duplicate_or_failed_required_jobs(self):
        original = self.jobs.copy()
        for jobs in (
            original[1:],
            original + [original[0]],
            [{**original[0], "conclusion": "failure"}, *original[1:]],
        ):
            with self.subTest(jobs=len(jobs)):
                self.jobs = jobs
                with self.assertRaises(ValueError):
                    self.verify()

    def test_rejects_wrong_producer_attempt_tree_or_commit(self):
        for field, value in (
            ("producer", "other/project"),
            ("attempt", 2),
            ("source_tree", "other"),
            ("parent", "c" * 40),
        ):
            with self.subTest(field=field):
                old = getattr(self, field)
                setattr(self, field, value)
                with self.assertRaises(ValueError):
                    self.verify()
                setattr(self, field, old)

    def test_rejects_failed_run_and_wrong_head(self):
        for field, value in (
            ("conclusion", "failure"),
            ("head_sha", "c" * 40),
            ("path", "other.yml"),
        ):
            with self.subTest(field=field):
                old = self.ci_run[field]
                self.ci_run[field] = value
                with self.assertRaises(ValueError):
                    self.verify()
                self.ci_run[field] = old

    def test_selects_latest_matching_pull_request_and_commit(self):
        unrelated = {**self.ci_run, "id": 99, "pull_requests": [{"number": 8}]}
        older = {**self.ci_run, "id": 40}
        self.assertEqual(
            ci_browser.select_run(
                [older, unrelated, self.ci_run], self.head, 7, self.repository
            ),
            self.ci_run,
        )
        self.assertIsNone(
            ci_browser.select_run([unrelated], self.head, 7, self.repository)
        )

    def test_pr_always_runs_website_even_for_unrelated_files(self):
        self.assertTrue(ci.website_required("pull_request", ["README.md"]))
        self.assertFalse(ci.website_required("push", ["README.md"]))
        self.assertTrue(ci.website_required("push", ["musical-leptos/src/app.rs"]))


if __name__ == "__main__":
    unittest.main()
