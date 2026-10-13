"""Package validated STM32 and ESP-IDF builds without touching a device."""

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def output(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def application_partition(table):
    entries = []
    for cursor in range(0, len(table), 32):
        entry = table[cursor : cursor + 32]
        if len(entry) != 32:
            raise ValueError("Truncated partition table")
        magic, kind, _, offset, size, _, _ = struct.unpack("<HBBII16sI", entry)
        if magic in (0xFFFF, 0xEBEB):
            break
        if magic != 0x50AA:
            raise ValueError("Invalid partition table")
        if kind == 0:
            entries.append((offset, size))
    if len(entries) != 1:
        raise ValueError("Expected one application partition")
    offset, size = entries[0]
    if offset != 0x10000 or size <= 0 or offset + size > 2 * 1024 * 1024:
        raise ValueError("Unsupported application partition")
    return offset, size


def inventory(directory):
    return {
        path.name: {
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in sorted(directory.iterdir())
        if path.is_file() and path.name not in ("manifest.json", "SHA256SUMS")
    }


def pack(package, destination):
    if output("git", "status", "--porcelain"):
        raise ValueError("Firmware packaging requires a clean source tree")
    destination.mkdir(parents=True, exist_ok=False)
    manifest = {
        "schema": 1,
        "package": package,
        "source_commit": output("git", "rev-parse", "HEAD"),
        "source_tree": output("git", "rev-parse", "HEAD^{tree}"),
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "physical_acceptance": "Pending; not flashed; timing profile unmeasured; battery Unknown",
    }
    if package == "stm32":
        compiler = "+nightly-2026-09-10"
        source = (
            ROOT
            / "musical-stm32/target/thumbv7em-none-eabihf/release/sensors_for_sparkle"
        )
        elf = destination / "sensors_for_sparkle.elf"
        shutil.copyfile(source, elf)
        sysroot = Path(output("rustc", compiler, "--print", "sysroot"))
        version = output("rustc", compiler, "--version", "--verbose")
        host = next(
            line.removeprefix("host: ")
            for line in version.splitlines()
            if line.startswith("host: ")
        )
        tool = sysroot / "lib/rustlib" / host / "bin/rust-objcopy"
        environment = os.environ.copy()
        if host.endswith("apple-darwin"):
            environment["DYLD_LIBRARY_PATH"] = str(sysroot / "lib")
        binary = destination / "sensors_for_sparkle.bin"
        subprocess.run(
            [str(tool), "-O", "binary", str(elf), str(binary)],
            env=environment,
            check=True,
        )
        if not 0 < binary.stat().st_size <= 256 * 1024:
            raise ValueError("STM32 image exceeds application flash")
        manifest.update(
            compiler=version,
            application_offset="0x08000000",
            flash_limit_bytes=256 * 1024,
        )
    else:
        project = ROOT / "musical-adafruit-sparkle-idf"
        release = project / "target/xtensa-esp32-espidf/release"
        interpreters = list(
            (project / ".embuild/espressif/python_env").glob(
                "idf6.1_py*_env/bin/python"
            )
        )
        if len(interpreters) != 1:
            raise ValueError(
                "Expected the build's single ESP-IDF 6.1 Python environment"
            )
        tool = [str(interpreters[0]), "-m", "esptool"]
        for name in ("bootloader.bin", "partition-table.bin"):
            shutil.copyfile(release / name, destination / name)
        boot = (destination / "bootloader.bin").read_bytes()
        if boot[:1] != b"\xe9" or boot[2:4] != b"\x02\x10":
            raise ValueError(
                "Bootloader does not use the DIO / 40 MHz / 2 MB development profile"
            )
        offset, capacity = application_partition(
            (destination / "partition-table.bin").read_bytes()
        )
        for name in ("net", "amulet"):
            elf = destination / (name + ".elf")
            binary = destination / (name + ".bin")
            shutil.copyfile(release / name, elf)
            subprocess.run(
                tool
                + [
                    "--chip",
                    "esp32",
                    "elf2image",
                    "--flash-mode",
                    "dio",
                    "--flash-freq",
                    "40m",
                    "--flash-size",
                    "2MB",
                    "--elf-sha256-offset",
                    "0xb0",
                    "--output",
                    str(binary),
                    str(elf),
                ],
                check=True,
            )
            if not 0 < binary.stat().st_size <= capacity:
                raise ValueError(f"{name} exceeds its application partition")
        manifest.update(
            compiler=output("rustc", "+esp-1.98.1.0", "--version", "--verbose"),
            sdk="ESP-IDF v6.1",
            image_tool=output(*tool, "version"),
            offsets={
                "bootloader.bin": "0x1000",
                "partition-table.bin": "0x8000",
                "application": hex(offset),
            },
            application_limit_bytes=capacity,
        )
    manifest["files"] = inventory(destination)
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "SHA256SUMS").write_text(
        "".join(
            entry["sha256"] + "  " + name + "\n"
            for name, entry in manifest["files"].items()
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", choices=("stm32", "esp-idf"))
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    pack(args.package, args.destination)
