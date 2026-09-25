"""Build the DOM-free analysis module and its AudioWorklet entry point."""

import shutil
import subprocess
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    subprocess.run(
        [
            "cargo",
            "+nightly-2026-09-10",
            "build",
            "--locked",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
        ],
        cwd=root,
        check=True,
    )
    output = root / "pkg"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir()
    shutil.copyfile(
        root / "target/wasm32-unknown-unknown/release/musical_lights_worklet.wasm",
        output / "loudness.wasm",
    )
    shutil.copyfile(root / "processor.js", output / "processor.js")
    shutil.copyfile(
        root.parent / "licenses/GPL-3.0-loudness.txt", output / "GPL-3.0-loudness.txt"
    )
    shutil.copyfile(
        root.parent / "THIRD_PARTY_NOTICES.md", output / "THIRD_PARTY_NOTICES.md"
    )
    (output / "SOURCE.txt").write_text(
        "Corresponding source: https://github.com/BlinkyStitt/musical-lights-rs\n"
        "The physics/build.js build identifier records the exact source revision.\n"
        "Build instructions and pinned tools: README.md and docs/validation.md.\n"
    )


if __name__ == "__main__":
    main()
