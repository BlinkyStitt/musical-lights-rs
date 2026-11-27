"""An artifact can replace validation only for the exact successful build inputs."""

import json
import os
import re
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
            "runner_arch": "X64",
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

    def test_container_consumer_verifies_same_source_recipe_and_platform(self):
        workflow = self.root / ".github/workflows/validate.yml"
        workflow.parent.mkdir(parents=True)
        workflow.write_text("jobs: pinned build and browser container")
        common = {
            "GITHUB_RUN_ID": "123",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_REPOSITORY": "owner/lights",
            "RUNNER_OS": "Linux",
            "RUNNER_ARCH": "X64",
        }
        bundle = self.root / "container-bundle"
        with patch.object(
            ci,
            "git",
            side_effect=lambda *args, **kwargs: "" if args[0] == "status" else "c" * 40,
        ):
            with patch.dict(os.environ, {**common, "ImageOS": "ubuntu24"}, clear=True):
                ci.pack(bundle, self.inventory, self.root)
            with patch.dict(os.environ, common, clear=True):
                ci.unpack(bundle, "123", self.root)
                manifest = ci.verify(bundle, ci.inputs(self.root), "123")
                self.assertEqual(manifest["producer_image"], "ubuntu24")
                for key in ("RUNNER_OS", "RUNNER_ARCH"):
                    with (
                        patch.dict(os.environ, {key: "different"}),
                        self.assertRaises(ValueError),
                    ):
                        ci.unpack(bundle, "123", self.root)
                workflow.write_text("jobs: different build recipe")
                with self.assertRaises(ValueError):
                    ci.unpack(bundle, "123", self.root)

    def test_superseded_schema_and_missing_producer_receipt_fail_closed(self):
        path = self.bundle / "provenance.json"
        original = json.loads(path.read_text())
        for replacement in (
            {**original, "schema": 1},
            {**original, "producer_image": None},
        ):
            path.write_text(json.dumps(replacement))
            with self.assertRaises(ValueError):
                ci.verify(self.bundle, self.expected, "123")

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
        jobs = responses["actions/runs/123/attempts/1/jobs?per_page=100"]["jobs"]
        native = next(job for job in jobs if job["name"] == "rust (core)")
        native["conclusion"] = "failure"
        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))
        native["conclusion"] = "success"
        jobs.remove(native)
        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))
        jobs.append(native)
        name = "GPU browser"
        job = next(job for job in jobs if job["name"] == name)
        jobs.remove(job)
        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))
        jobs.append(job)
        for conclusion in ("failure", "skipped", "cancelled"):
            job["conclusion"] = conclusion
            self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))
        job["conclusion"] = "success"
        for conclusion in ("success", "failure"):
            jobs.append({**job, "conclusion": conclusion})
            self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))
            jobs.pop()
        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("123", "456"))
        (self.bundle / ci.PAYLOAD[0] / "sample.wasm").write_bytes(b"tampered")
        self.assertEqual(ci.reusable(repo, self.expected, read, fetch), ("", ""))


class WebsiteValidationBarrierTests(unittest.TestCase):
    def needs(self, reuse):
        return {
            "plan": {
                "result": "success",
                "outputs": {
                    "site_required": "true",
                    "reuse": "true" if reuse else "false",
                    "run_id": "123" if reuse else "",
                    "artifact_id": "456" if reuse else "",
                },
            },
            "web": {"result": "success"},
            **{
                job: {"result": "skipped" if reuse else "success"}
                for job in (
                    "core",
                    "loudness-reference",
                    "browser",
                    "gpu",
                )
            },
        }

    def test_complete_fresh_validation_and_exact_verified_reuse_pass(self):
        for reuse in (False, True):
            ci.require_website_validation(self.needs(reuse))

    def test_failed_canceled_or_incomplete_dependencies_never_pass(self):
        for reuse in (False, True):
            for job in self.needs(reuse):
                expected = self.needs(reuse)[job]["result"]
                for result in {"success", "failure", "cancelled", "skipped"} - {
                    expected
                }:
                    needs = self.needs(reuse)
                    needs[job]["result"] = result
                    with (
                        self.subTest(reuse=reuse, job=job, result=result),
                        self.assertRaises(ValueError),
                    ):
                        ci.require_website_validation(needs)
                needs = self.needs(reuse)
                del needs[job]
                with self.assertRaises(ValueError):
                    ci.require_website_validation(needs)
            needs = self.needs(reuse)
            needs["unexpected"] = {"result": "success"}
            with self.assertRaises(ValueError):
                ci.require_website_validation(needs)

    def test_reuse_requires_the_producer_and_explicit_selection(self):
        for key, values in {
            "reuse": (None, "", "yes"),
            "site_required": (None, "false"),
            "run_id": (None, "", "unverified", 123),
            "artifact_id": (None, "", "unverified", 456),
        }.items():
            for value in values:
                needs = self.needs(True)
                needs["plan"]["outputs"][key] = value
                with (
                    self.subTest(key=key, value=value),
                    self.assertRaises(ValueError),
                ):
                    ci.require_website_validation(needs)

    def test_workflow_reuses_gpu_acceptance_with_the_other_validators(self):
        source = (ci.ROOT / ".github/workflows/validate.yml").read_text()

        def job(name):
            match = re.search(
                rf"^  {name}:\n(.*?)(?=^  [\w-]+:|\Z)",
                source,
                re.MULTILINE | re.DOTALL,
            )
            assert match is not None
            return match[1]

        fresh = re.search(r"^    if: (.+)$", job("core"), re.MULTILINE)
        assert fresh is not None
        condition = re.search(r"^    if: (.+)$", job("gpu"), re.MULTILINE)
        assert condition is not None
        self.assertEqual(condition[1], fresh[1])
        self.assertIn("needs: [plan, web]", job("gpu"))
        barrier = job("validated")
        self.assertIn("browser, gpu]", barrier)
        self.assertIn("GPU browser", ci.VALIDATORS)
        self.assertIn("always() && !cancelled()", barrier)
        self.assertIn("CI_NEEDS: ${{ toJSON(needs) }}", barrier)
        self.assertIn("run: python3 validation/ci.py validation-barrier", barrier)
        self.assertLess(
            barrier.index("validation-barrier"),
            barrier.index("Verify producer and byte digests"),
        )


class ChangeTests(unittest.TestCase):
    def test_changes_command_selects_provisioning_without_unrelated_builds(self):
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory) / "event.json"
            event.write_text("{}")
            for paths, flags in (
                (["docs/validation.md"], (False, False, False, False)),
                (["tools/firmware/provision.py"], (True, False, False, False)),
                (["musical-stm32/src/main.rs"], (True, True, False, False)),
                (
                    ["musical-recognition-worker/src/lib.rs"],
                    (False, False, False, True),
                ),
                (None, (True, True, True, True)),
            ):
                with (
                    self.subTest(paths=paths),
                    patch.dict(os.environ, GITHUB_EVENT_PATH=str(event)),
                    patch.object(sys, "argv", ["ci.py", "changes"]),
                    patch.object(ci, "changed_paths", return_value=paths),
                    patch.object(ci, "output") as publish,
                ):
                    ci.main()
                outputs = publish.call_args.args[0]
                self.assertEqual(
                    tuple(
                        outputs[key]
                        for key in ("firmware_tools", "rust", "esp", "recognition")
                    ),
                    flags,
                )

    def test_site_selects_shared_and_web_paths_but_not_docs_or_other_apps(self):
        for path in (
            "musical-lights-core/src/lib.rs",
            "musical-leptos/public/styles.css",
            "musical-lights-physics/build.py",
            "musical-lights-worklet/src/lib.rs",
            "validation/tests/color-fill.spec.mjs",
            "validation/tooling/test_ci.py",
            "docs/audio-audit-results/report.json",
            ".github/workflows/validate.yml",
            ".github/workflows/gpu-runner-network.yml",
            "musical-leptos/.cargo/config.toml",
            "rust-toolchain.toml",
            "Cargo.lock",
        ):
            with self.subTest(path=path):
                self.assertTrue(ci.site_affected([path]))
        for path in (
            "README.md",
            "docs/validation.md",
            "validation/demos.config.mjs",
            "validation/tests/other-apps.spec.mjs",
            "musical-terminal/src/main.rs",
            "musical-recognition-worker/src/lib.rs",
        ):
            with self.subTest(path=path):
                self.assertFalse(ci.site_affected([path]))
        self.assertTrue(ci.site_affected(None))
        self.assertFalse(ci.site_affected([]))
        self.assertTrue(ci.site_affected(["README.md", "musical-leptos/src/app.rs"]))

    def test_recognition_selects_its_code_workflow_and_toolchain(self):
        for path in (
            "musical-recognition-worker/src/lib.rs",
            ".github/workflows/recognition.yml",
            "rust-toolchain.toml",
            ".cargo/config.toml",
        ):
            self.assertTrue(ci.recognition_affected([path]))
        for paths in ([], ["docs/validation.md"], ["musical-leptos/src/app.rs"]):
            self.assertFalse(ci.recognition_affected(paths))
        self.assertTrue(ci.recognition_affected(None))

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


class RequiredChecksTests(unittest.TestCase):
    def cases(self):
        # GitHub's toJSON(needs) exposes matrix aggregate results, not one
        # dependency per matrix child. A failed child must fail that aggregate.
        return (
            ("website", "plan", {"validated": "site_required"}),
            ("other-apps", "changes", {"terminal": "terminal", "demos": "demos"}),
            (
                "firmware",
                "changes",
                {"firmware-tools": "firmware_tools", "rust": "rust", "esp": "esp"},
            ),
            ("recognition", "changes", {"worker": "recognition"}),
        )

    def needs(self, selector, jobs, selected):
        return {
            selector: {
                "result": "success",
                "outputs": {flag: selected for flag in jobs.values()},
            },
            **{name: {"result": "success"} for name in jobs},
        }

    def test_workflow_selectors_run_for_draft_and_ready_pull_requests(self):
        # A required gate cannot validate a draft checkpoint if its root
        # selector is skipped. Keep roots unconditional; only their outputs
        # may exclude unaffected downstream applications.
        for group, selector, _ in self.cases():
            workflow = "validate" if group == "website" else group
            source = (ci.ROOT / ".github/workflows" / f"{workflow}.yml").read_text()
            with self.subTest(workflow=workflow):
                root = re.search(
                    rf"^  {selector}:\n((?:^    .*\n|^\n)+)", source, re.MULTILINE
                )
                self.assertIsNotNone(root, "Missing change-selection job")
                assert root is not None
                keys = re.findall(r"^    ([\w-]+):", root[1], re.MULTILINE)
                self.assertNotIn("if", keys, "Change selection must run on drafts")
                self.assertNotIn("needs", keys, "Change selection must be a root")

    def test_success_and_explicitly_unselected_skips_pass(self):
        for group, selector, jobs in self.cases():
            with self.subTest(group=group):
                ci.require_checks(group, self.needs(selector, jobs, "true"))
                needs = self.needs(selector, jobs, "false")
                for job in jobs:
                    needs[job]["result"] = "skipped"
                ci.require_checks(group, needs)
                # A workflow can run extra checks. Their success is valid.
                ci.require_checks(group, self.needs(selector, jobs, "false"))

    def test_selected_skips_fail_and_all_failures_or_cancellations_fail(self):
        for group, selector, jobs in self.cases():
            for job in jobs:
                for selected, result in (
                    ("true", "skipped"),
                    ("true", "failure"),
                    ("true", "cancelled"),
                    ("false", "failure"),
                    ("false", "cancelled"),
                ):
                    needs = self.needs(selector, jobs, selected)
                    needs[job]["result"] = result
                    with (
                        self.subTest(
                            group=group, job=job, flag=selected, result=result
                        ),
                        self.assertRaises(ValueError),
                    ):
                        ci.require_checks(group, needs)

    def test_failed_skipped_cancelled_and_missing_selectors_never_pass(self):
        for group, selector, jobs in self.cases():
            for result in ("failure", "skipped", "cancelled"):
                needs = self.needs(selector, jobs, "false")
                needs[selector]["result"] = result
                with (
                    self.subTest(group=group, result=result),
                    self.assertRaises(ValueError),
                ):
                    ci.require_checks(group, needs)
            for missing in (selector, *jobs):
                needs = self.needs(selector, jobs, "true")
                del needs[missing]
                with (
                    self.subTest(group=group, missing=missing),
                    self.assertRaises(ValueError),
                ):
                    ci.require_checks(group, needs)
            for invalid in (None, "", "TRUE", "unknown"):
                for flag in jobs.values():
                    needs = self.needs(selector, jobs, "true")
                    needs[selector]["outputs"][flag] = invalid
                    with (
                        self.subTest(group=group, flag=flag, invalid=invalid),
                        self.assertRaises(ValueError),
                    ):
                        ci.require_checks(group, needs)

    def test_one_failed_firmware_matrix_cannot_hide_behind_unselected_matrix(self):
        needs = self.needs(
            "changes",
            {"firmware-tools": "firmware_tools", "rust": "rust", "esp": "esp"},
            "false",
        )
        needs["changes"]["outputs"].update(firmware_tools="true", rust="true")
        needs["firmware-tools"]["result"] = "success"
        needs["rust"]["result"] = "failure"
        needs["esp"]["result"] = "skipped"
        with self.assertRaisesRegex(ValueError, "rust"):
            ci.require_checks("firmware", needs)


class BrowserGroupTests(unittest.TestCase):
    def inventory(self):
        return {
            "suites": [
                {
                    "title": "large.spec.mjs",
                    "specs": [],
                    "suites": [
                        {
                            "title": "rotation",
                            "specs": [
                                {
                                    "id": str(index),
                                    "file": "large.spec.mjs",
                                    "title": f"turn {index}",
                                    "tests": [
                                        {"projectName": project}
                                        for project in ci.BROWSER_PROJECTS
                                    ],
                                }
                                for index in range(12)
                            ],
                        }
                    ],
                }
            ]
        }

    def test_every_case_runs_once_with_nested_titles_and_deterministic_groups(self):
        inventory = self.inventory()
        groups = ci.browser_groups(inventory)
        cases = [case for group in groups.values() for case in group]
        self.assertEqual(len(groups), 3)
        self.assertEqual(len(cases), 48)
        self.assertEqual(len(set(cases)), 48)
        self.assertTrue(all(groups.values()))
        self.assertTrue(
            all("large.spec.mjs › rotation › turn " in case for case in cases)
        )
        inventory["suites"][0]["suites"][0]["specs"].reverse()
        self.assertEqual(ci.browser_groups(inventory), groups)

    def test_duration_assigns_whole_project_files_to_the_lightest_group(self):
        report = self.inventory()
        specs = report["suites"][0]["suites"][0]["specs"]
        specs[0]["file"] = "second.spec.mjs"
        times = {
            project: {"large.spec.mjs": duration, "second.spec.mjs": 1}
            for project, duration in zip(ci.BROWSER_PROJECTS, (9000, 8000, 7000, 1000))
        }
        groups = ci.browser_groups(report, times)
        for index, project in enumerate(ci.BROWSER_PROJECTS[:3], 1):
            cases = groups[f"software-{index}"]
            self.assertEqual(
                sum(case.startswith(f"[{project}] › large.spec.mjs") for case in cases),
                11,
            )
        lightest = groups["software-3"]
        self.assertEqual(
            sum(
                case.startswith("[iphone-webkit] › large.spec.mjs") for case in lightest
            ),
            11,
        )

    def test_diagnostic_groups_retain_the_prior_case_selection(self):
        report = self.inventory()
        canonical = list(ci.browser_cases(report))
        for name, projects, selection in (
            ("chromium-5", ("chromium", "chromium-permissions"), slice(4, None, 10)),
            ("webkit-2", ("webkit-spectrum", "iphone-webkit"), slice(1, None, 8)),
        ):
            cases = sorted(
                case for project, _, case in canonical if project in projects
            )
            self.assertEqual(ci.browser_list(report, name), cases[selection])

    def test_unknown_duplicate_empty_and_unrepresentable_cases_fail_closed(self):
        for failure in ("unknown", "duplicate", "empty", "delimiter", "newline"):
            with self.subTest(failure=failure):
                inventory = self.inventory()
                specs = inventory["suites"][0]["suites"][0]["specs"]
                if failure == "unknown":
                    specs[0]["tests"][0]["projectName"] = "new-browser"
                elif failure == "duplicate":
                    specs.append(specs[0])
                elif failure == "empty":
                    specs.clear()
                else:
                    specs[0]["title"] = "bad" + (
                        "›" if failure == "delimiter" else "\n"
                    )
                with self.assertRaises(ValueError):
                    ci.browser_groups(inventory)


if __name__ == "__main__":
    unittest.main()
