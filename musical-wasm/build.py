#!/usr/bin/env python3
"""Build the shared-memory audio worklet with matching wasm-bindgen tooling."""
import json
import os
from pathlib import Path
import subprocess


def main():
    root = Path(__file__).resolve().parent
    metadata = json.loads(subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--locked"],
        cwd=root, check=True, capture_output=True, text=True,
    ).stdout)
    version = next(p["version"] for p in metadata["packages"] if p["name"] == "wasm-bindgen")
    cli = subprocess.run(["wasm-bindgen", "--version"], check=True, capture_output=True, text=True).stdout.strip()
    if cli != f"wasm-bindgen {version}":
        raise RuntimeError(f"Install wasm-bindgen-cli {version}; found {cli}")
    env = os.environ.copy()
    # Atomics alone no longer marks the linked memory as shared.
    env["RUSTFLAGS"] = (
        "-C target-feature=+atomics,+bulk-memory,+mutable-globals "
        "-C link-arg=--shared-memory -C link-arg=--import-memory "
        "-C link-arg=--max-memory=1073741824 "
        "-C link-arg=--export=__heap_base -C link-arg=--export=__wasm_init_tls "
        "-C link-arg=--export=__tls_size -C link-arg=--export=__tls_align "
        "-C link-arg=--export=__tls_base"
    )
    subprocess.run([
        "cargo", "build", "--locked", "--target", "wasm32-unknown-unknown", "--release",
        "-Zbuild-std=std,panic_abort",
    ], cwd=root, env=env, check=True)
    artifact = Path(metadata["target_directory"]) / "wasm32-unknown-unknown/release/wasm_audio_worklet.wasm"
    subprocess.run([
        "wasm-bindgen", str(artifact), "--out-dir", str(root / "pkg"),
        "--target", "web", "--split-linked-modules",
    ], cwd=root, check=True)


if __name__ == "__main__":
    main()
