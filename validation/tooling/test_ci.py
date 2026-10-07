"""An artifact can replace validation only for the exact successful build inputs."""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ci


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        self.expected = {
            "source_tree": "tree",
            "workflow": "workflow",
            "runner_os": "Linux",
        }
        for name in ci.PAYLOAD:
            path = self.root / name / "sample.wasm"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"actual compiled bytes")
        self.inventory = self.root / "inventory.json"
        self.inventory.write_text(json.dumps(self.report("one", "two")))
        with (
            patch.object(ci, "inputs", return_value=self.expected),
            patch.object(
                ci,
                "git",
                side_effect=lambda *args, **kwargs: (
                    "" if args[0] == "status" else "c" * 40
                ),
            ),
            patch.dict(
                os.environ,
                GITHUB_RUN_ID="123",
                GITHUB_RUN_ATTEMPT="1",
                GITHUB_REPOSITORY="owner/lights",
                GITHUB_EVENT_PATH="",
            ),
        ):
            ci.pack(self.bundle, self.inventory, self.root)

    def report(self, *ids, unexpected=0):
        return {
            "suites": [
                {
                    "specs": [
                        {
                            "id": name,
                            "tests": [
                                {
                                    "projectName": "chromium",
                                    "status": "expected",
                                    "expectedStatus": "passed",
                                    "results": [{"status": "passed"}],
                                }
                            ],
                        }
                        for name in ids
                    ]
                }
            ],
            "stats": {"unexpected": unexpected},
            "errors": [],
        }

    def test_exact_bundle_restores_every_compiled_package(self):
        for name in ci.PAYLOAD:
            shutil.rmtree(self.root / name)
        with patch.object(ci, "inputs", return_value=self.expected):
            ci.unpack(self.bundle, "123", self.root)
        for name in ci.PAYLOAD:
            self.assertEqual(
                (self.root / name / "sample.wasm").read_bytes(),
                b"actual compiled bytes",
            )

    def test_refuses_different_tree_tools_runner_or_producer(self):
        for key in self.expected:
            with self.subTest(key=key), self.assertRaises(ValueError):
                ci.verify(self.bundle, {**self.expected, key: "different"}, "123")
        with self.assertRaises(ValueError):
            ci.verify(self.bundle, self.expected, "124")

    def test_refuses_corruption_extra_files_missing_payload_and_symlinks(self):
        sample = self.bundle / ci.PAYLOAD[0] / "sample.wasm"
        sample.write_bytes(b"corrupted")
        with self.assertRaises(ValueError):
            ci.verify(self.bundle, self.expected, "123")
        sample.write_bytes(b"actual compiled bytes")
        extra = self.bundle / "injected.js"
        extra.write_text("unexpected")
        with self.assertRaises(ValueError):
            ci.verify(self.bundle, self.expected, "123")
        extra.unlink()
        extra.symlink_to(sample)
        with self.assertRaises(ValueError):
            ci.verify(self.bundle, self.expected, "123")
        extra.unlink()
        sample.unlink()
        with self.assertRaises(ValueError):
            ci.verify(self.bundle, self.expected, "123")

    def test_coverage_requires_every_test_once_and_no_failures(self):
        a, b = self.root / "a.json", self.root / "b.json"
        a.write_text(json.dumps(self.report("one")))
        b.write_text(json.dumps(self.report("two")))
        ci.coverage(self.inventory, [a, b])
        for report in (
            self.report("one"),
            self.report("three"),
            self.report("two", unexpected=1),
        ):
            b.write_text(json.dumps(report))
            with self.assertRaises(ValueError):
                ci.coverage(self.inventory, [a, b])
        for results in ([], [{"status": "passed"}, {"status": "passed"}]):
            document = self.report("two")
            document["suites"][0]["specs"][0]["tests"][0]["results"] = results
            b.write_text(json.dumps(document))
            with self.assertRaises(ValueError):
                ci.coverage(self.inventory, [a, b])

    def test_reuse_requires_trusted_successful_complete_validation(self):
        repo = "owner/lights"
        run = {
            "id": 123,
            "run_attempt": 1,
            "head_sha": "head",
            "head_repository": {"full_name": repo},
            "path": ".github/workflows/validate.yml",
            "workflow_id": 42,
            "event": "pull_request",
            "status": "completed",
            "conclusion": "success",
        }
        responses = {
            "actions/workflows/validate.yml": {"id": 42},
            "actions/artifacts?name=validated-site-tree&per_page=100": {
                "artifacts": [
                    {
                        "id": 456,
                        "name": "validated-site-tree",
                        "expired": False,
                        "workflow_run": {"id": 123},
                    }
                ]
            },
            "actions/runs/123": run,
            "git/commits/" + "c" * 40: {
                "tree": {"sha": "tree"},
                "parents": [{"sha": "head"}],
            },
            "actions/runs/123/attempts/1/jobs?per_page=100": {
                "jobs": [
                    {"name": name, "conclusion": "success"} for name in ci.VALIDATORS
                ]
            },
        }

        def read(repository, path):
            self.assertEqual(repository, repo)
            return responses[path]

        def fetch(repository, candidate, directory):
            shutil.copytree(self.bundle, directory, dirs_exist_ok=True)

        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("123", "456"))
        run["head_repository"]["full_name"] = "fork/lights"
        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))
        run["head_repository"]["full_name"] = repo
        responses["actions/runs/123/attempts/1/jobs?per_page=100"]["jobs"][0][
            "conclusion"
        ] = "failure"
        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))
        responses["actions/runs/123/attempts/1/jobs?per_page=100"]["jobs"][0][
            "conclusion"
        ] = "success"
        (self.bundle / ci.PAYLOAD[0] / "sample.wasm").write_bytes(b"tampered")
        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))


class ChangeTests(unittest.TestCase):
    def test_shared_core_and_pinned_build_changes_reach_all_consumers(self):
        for path in (
            "musical-lights-core/src/audio/mod.rs",
            "Cargo.lock",
            "validation/ci.py",
            "musical-feather-m0/.cargo/config.toml",
        ):
            for package, workflow in (
                ("musical-terminal", "other-apps"),
                ("musical-feather-m0", "firmware"),
            ):
                self.assertTrue(ci.affected([path], package, workflow))

    def test_web_controls_and_tests_do_not_rebuild_unrelated_apps(self):
        paths = [
            "musical-leptos/public/styles.css",
            "validation/tests/keyboard.spec.mjs",
        ]
        self.assertFalse(ci.affected(paths, "musical-terminal", "other-apps"))
        self.assertFalse(ci.affected(paths, "musical-feather-m0", "firmware"))
        self.assertTrue(
            ci.affected(
                ["musical-feather-m0/src/main.rs"], "musical-feather-m0", "firmware"
            )
        )
        self.assertFalse(
            ci.affected(["musical-feather-m0/src/main.rs"], "musical-stm32", "firmware")
        )
        self.assertTrue(
            ci.affected(
                ["validation/tests/other-apps.spec.mjs"], "musical-dioxus", "other-apps"
            )
        )
        self.assertFalse(
            ci.affected(
                ["validation/tests/other-apps.spec.mjs"],
                "musical-terminal",
                "other-apps",
            )
        )


if __name__ == "__main__":
    unittest.main()
