#!/usr/bin/env python3
"""Install frozen upstream CLI binaries into .tools/bin (macOS or Linux)."""

import argparse
import platform
import shutil
import subprocess
import tarfile
import tempfile
import time
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def download(url: str, destination: Path) -> None:
    """Retry transient upstream failures; never replace a good file with a partial one."""
    with tempfile.TemporaryDirectory(dir=destination.parent) as directory:
        partial = Path(directory) / "download"
        for attempt in range(4):
            print(f"Downloading {url} (attempt {attempt + 1}/4)", flush=True)
            try:
                with urlopen(url, timeout=30) as response, partial.open("wb") as output:
                    shutil.copyfileobj(response, output)
                    expected = response.headers.get("Content-Length")
                if expected is not None and partial.stat().st_size != int(expected):
                    raise URLError("Incomplete download")
                partial.replace(destination)
                return
            except (URLError, TimeoutError, ConnectionError, IncompleteRead) as error:
                if isinstance(error, HTTPError) and not (
                    error.code in (408, 429) or 500 <= error.code < 600
                ):
                    raise
                if attempt == 3:
                    raise
                print(f"Transient download failure: {error}; retrying", flush=True)
                time.sleep(2**attempt)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("group", choices=["web", "site", "demos", "esp"])
    args = parser.parse_args()
    machine = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64"}[
        platform.machine()
    ]
    system = {"Darwin": "apple-darwin", "Linux": "unknown-linux-gnu"}[platform.system()]
    target = f"{machine}-{system}"
    bindir = ROOT / ".tools/bin"
    bindir.mkdir(parents=True, exist_ok=True)
    if args.group == "esp":
        download(
            f"https://github.com/esp-rs/espup/releases/download/v0.17.1/espup-{target}",
            bindir / "espup",
        )
        (bindir / "espup").chmod(0o755)
        subprocess.run(
            [
                "cargo",
                "+nightly-2026-09-10",
                "install",
                "ldproxy",
                "--version",
                "0.3.5",
                "--locked",
                "--root",
                str(ROOT / ".tools"),
            ],
            check=True,
        )
    else:
        node_system = {"Darwin": "darwin", "Linux": "linux"}[platform.system()]
        node_machine = {"aarch64": "arm64", "x86_64": "x64"}[machine]
        node_name = f"node-v26.8.2-{node_system}-{node_machine}"
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "node.tar.gz"
            download(f"https://nodejs.org/dist/v26.8.2/{node_name}.tar.gz", archive)
            subprocess.run(["tar", "-xzf", str(archive), "-C", directory], check=True)
            shutil.copytree(
                Path(directory) / node_name,
                ROOT / ".tools/node",
                symlinks=True,
                dirs_exist_ok=True,
            )
        for binary in ["node", "npm", "npx"]:
            link = bindir / binary
            if link.is_symlink():
                link.unlink()
            link.symlink_to(Path("../node/bin") / binary)
        wasm_target = (
            "x86_64-unknown-linux-musl"
            if target == "x86_64-unknown-linux-gnu"
            else target
        )
        releases = [
            ("trunk-rs/trunk", "v0.22.0-beta.5", f"trunk-{target}.tar.gz", ["trunk"]),
            ("DioxusLabs/dioxus", "v0.8.0-alpha.1", f"dx-{target}.tar.gz", ["dx"]),
            (
                "wasm-bindgen/wasm-bindgen",
                "0.2.128",
                f"wasm-bindgen-0.2.128-{wasm_target}.tar.gz",
                ["wasm-bindgen", "wasm-bindgen-test-runner"],
            ),
        ]
        # Keep `web` as the complete local toolchain, but production website
        # CI must not depend on downloading the separate Dioxus CLI.
        if args.group == "site":
            releases = [
                release for release in releases if release[0] != "DioxusLabs/dioxus"
            ]
        elif args.group == "demos":
            releases = [
                release for release in releases if release[0] != "trunk-rs/trunk"
            ]
        for repository, tag, asset, binaries in releases:
            with tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / asset
                download(
                    f"https://github.com/{repository}/releases/download/{tag}/{asset}",
                    archive,
                )
                with tarfile.open(archive) as package:
                    for binary in binaries:
                        member = next(
                            m
                            for m in package.getmembers()
                            if m.isfile() and Path(m.name).name == binary
                        )
                        source = package.extractfile(member)
                        if source is None:
                            raise ValueError(f"Missing binary {binary} in {asset}")
                        with source, (bindir / binary).open("wb") as destination:
                            shutil.copyfileobj(source, destination)
                        (bindir / binary).chmod(0o755)
    print(f"Add {bindir} to PATH")


if __name__ == "__main__":
    main()
