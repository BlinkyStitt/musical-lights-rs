"""Full browser validation must retain demos and propagate missing tools/failures."""

import subprocess
import sys
import unittest
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


if __name__ == "__main__":
    unittest.main()
