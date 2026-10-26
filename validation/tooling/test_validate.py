"""Pinned validation phases retain every required check and propagate failures."""

import subprocess
import sys
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from validation import validate


class BrowserValidationTests(unittest.TestCase):
    def test_browser_runs_unfiltered_suite_after_installing_dependencies(self):
        with patch.object(validate.subprocess, "run") as run:
            validate.validate("browser")
        directory = validate.ROOT / "validation"
        self.assertEqual(
            run.call_args_list,
            [
                call(["npm", "ci", "--ignore-scripts"], cwd=directory, check=True),
                call(
                    ["npx", "playwright", "install", "chromium", "webkit"],
                    cwd=directory,
                    check=True,
                ),
                call(["npm", "test"], cwd=directory, check=True),
            ],
        )

    def test_browser_stops_at_each_failed_step(self):
        for step in range(3):
            for error in (
                FileNotFoundError("required executable is absent"),
                subprocess.CalledProcessError(1, "required check"),
            ):
                with (
                    self.subTest(step=step, error=type(error).__name__),
                    patch.object(
                        validate.subprocess, "run", side_effect=[None] * step + [error]
                    ) as run,
                    self.assertRaises(type(error)),
                ):
                    validate.validate("browser")
                self.assertEqual(run.call_count, step + 1)

    def test_dioxus_cannot_build_with_missing_or_mismatched_cli(self):
        for error, version in (
            (FileNotFoundError("dx"), None),
            (None, "dioxus 0.7.0"),
        ):
            with (
                self.subTest(error=error, version=version),
                patch.object(validate, "run") as run,
                patch.object(
                    validate.subprocess,
                    "check_output",
                    side_effect=error,
                    return_value=version,
                ),
                self.assertRaises((FileNotFoundError, RuntimeError)),
            ):
                validate.validate("dioxus")
            self.assertFalse(any(args[0][0][0] == "dx" for args in run.call_args_list))


class PhysicsValidationTests(unittest.TestCase):
    def commands(self, name):
        with patch.object(validate, "run") as run:
            validate.validate(name)
        return [call.args for call in run.call_args_list]

    def test_full_physics_retains_native_and_wasm_checks(self):
        cargo = ["cargo", f"+{validate.NIGHTLY}"]
        directory = validate.ROOT / "musical-lights-physics"
        self.assertEqual(
            self.commands("physics"),
            [
                (
                    ["rustc", f"+{validate.NIGHTLY}", "--version", "--verbose"],
                    directory,
                ),
                (cargo + ["fmt", "--all", "--", "--check"], directory),
                (cargo + ["test", "--locked"], directory),
                (
                    cargo
                    + ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"],
                    directory,
                ),
                (
                    cargo
                    + [
                        "clippy",
                        "--locked",
                        "--target",
                        "wasm32-unknown-unknown",
                        "--",
                        "-D",
                        "warnings",
                    ],
                    directory,
                ),
                (["python3", "build.py"], directory),
            ],
        )

    def test_native_and_wasm_phases_partition_the_complete_workload(self):
        full = self.commands("physics")
        native = self.commands("physics-native")
        wasm = self.commands("physics-wasm")

        # Both runners still check the compiler and formatting. Each semantic
        # check and the compiled package producer must otherwise run once.
        def counts(commands):
            return Counter((tuple(args), directory) for args, directory in commands)

        self.assertEqual(counts(native[:2]), counts(full[:2]))
        self.assertEqual(counts(wasm[:2]), counts(full[:2]))
        self.assertEqual(counts(native[2:] + wasm[2:]), counts(full[2:]))
        self.assertNotIn(
            (["python3", "build.py"], validate.ROOT / "musical-lights-physics"), native
        )

    def test_each_phase_stops_at_a_failed_required_check(self):
        for name in ("physics-native", "physics-wasm"):
            for step in range(len(self.commands(name))):
                error = subprocess.CalledProcessError(1, "required physics check")
                with (
                    self.subTest(phase=name, step=step),
                    patch.object(
                        validate, "run", side_effect=[None] * step + [error]
                    ) as run,
                    self.assertRaises(subprocess.CalledProcessError),
                ):
                    validate.validate(name)
                self.assertEqual(run.call_count, step + 1)


if __name__ == "__main__":
    unittest.main()
