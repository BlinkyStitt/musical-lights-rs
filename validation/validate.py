#!/usr/bin/env python3
"""Validate each independent package from its own directory and pinned toolchain."""
import argparse
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
NIGHTLY = "nightly-2026-09-10"
ESP = "esp-1.98.1.0"
PACKAGES = {
    "core": "musical-lights-core", "terminal": "musical-terminal",
    "leptos": "musical-leptos", "dioxus": "musical-dioxus", "wasm": "musical-wasm",
    "feather": "musical-feather-m0", "stm32": "musical-stm32",
    "esp-embassy": "musical-adafruit-sparkle-embassy", "esp-idf": "musical-adafruit-sparkle-idf",
}


def run(args, directory):
    print(f"[{directory.name}] {' '.join(args)}", flush=True)
    subprocess.run(args, cwd=directory, check=True)


def cli_version(binary, version):
    found = subprocess.check_output([binary, "--version"], text=True).strip()
    label = "dioxus" if binary == "dx" else binary
    if not found.startswith(f"{label} {version}"):
        raise RuntimeError(f"Expected {binary} {version}; found {found}")


def validate(name):
    if name == "browser":
        run(["npm", "ci", "--ignore-scripts"], ROOT / "validation")
        run(["npx", "playwright", "install", "chromium"], ROOT / "validation")
        run(["npm", "test"], ROOT / "validation")
        return
    directory = ROOT / PACKAGES[name]
    toolchain = ESP if name.startswith("esp-") else NIGHTLY
    cargo = ["cargo", f"+{toolchain}"]
    run(["rustc", f"+{toolchain}", "--version", "--verbose"], directory)
    run(cargo + ["fmt", "--all", "--", "--check"], directory)
    if name == "core":
        for features in [None, "std,log", "libm,log", "libm,alloc,log"]:
            flags = [] if features is None else ["--no-default-features", "--features", features]
            run(cargo + ["test", "--locked"] + flags, directory)
        for features in ["libm", "libm,alloc", "libm,log", "libm,defmt,embassy", "libm,alloc,defmt,embassy", "std,alloc,log,defmt,embassy"]:
            run(cargo + ["clippy", "--locked", "--no-default-features", "--features", features, "--", "-D", "warnings"], directory)
        run(cargo + ["clippy", "--locked", "--all-targets", "--features", "log", "--", "-D", "warnings"], directory)
        run(cargo + ["run", "--locked", "--release", "--example", "bark_cost", "--features", "std,log"], directory)
    elif name == "terminal":
        run(cargo + ["test", "--locked", "--lib"], directory)
        run(cargo + ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"], directory)
        run(cargo + ["build", "--locked", "--release", "--bins", "--examples"], directory)
    elif name in ["leptos", "dioxus", "wasm"]:
        run(cargo + ["clippy", "--locked", "--target", "wasm32-unknown-unknown", "--", "-D", "warnings"], directory)
        if name == "leptos":
            cli_version("trunk", "0.22.0-beta.5")
            cli_version("wasm-bindgen", "0.2.128")
            run(["trunk", "build", "--locked", "--release"], directory)
        elif name == "dioxus":
            cli_version("dx", "0.8.0-alpha.1")
            run(["dx", "build", "--web", "--release", "--locked"], directory)
        else:
            run(["python3", "build.py"], directory)
    else:
        # Retain visible warnings for IDF's existing inactive sensor/pattern code.
        lint_flags = [] if name == "esp-idf" else ["--", "-D", "warnings"]
        run(cargo + ["clippy", "--locked", "--bins"] + lint_flags, directory)
        run(cargo + ["build", "--locked", "--release", "--bins"], directory)
        if name == "feather":
            run(cargo + ["build", "--locked", "--release", "--no-default-features", "--features", "use_semihosting"], directory)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("packages", nargs="+", choices=[*PACKAGES, "browser", "all"])
    args = parser.parse_args()
    os.environ["PATH"] = str(ROOT / ".tools/bin") + os.pathsep + os.environ["PATH"]
    for name in ([*PACKAGES, "browser"] if "all" in args.packages else args.packages):
        validate(name)


if __name__ == "__main__":
    main()
