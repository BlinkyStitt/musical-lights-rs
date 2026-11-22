"""Materialize only authentic, exact-run Musical Lights reports for upload-artifact."""

import argparse
import hashlib
import shutil
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath

from scripts.ci_gpu_collect import public_archive_member
from scripts.ci_gpu_courier import MAX_RELAY_BYTES, verify_reply
from scripts.ci_gpu_guest import approved_run

MAX_BYTES = 300 * 2**20
SMALL = {
    "approved-run.json": 4096,
    "request.json": MAX_RELAY_BYTES,
    "reply.json": MAX_RELAY_BYTES,
    "reply.json.sig": MAX_RELAY_BYTES,
}
EVIDENCE = "evidence.tar.gz"
OUTPUTS = {
    PurePosixPath("source/validation/test-results"): "gpu-browser-report",
    PurePosixPath("source/.ci/active-gap"): "active-gap-evidence",
    PurePosixPath("source/.ci/tilt-lighting"): "tilt-lighting-comparison",
}


def reports(raw: Path, target: Path, shard: int) -> None:
    seen = set()
    expected = {0} if shard == 2 else {0, 1, 2}
    populated = set()
    total = 0
    with tarfile.open(raw, "r:gz") as archive:
        for entry in archive:
            name = PurePosixPath(entry.name)
            total += entry.size
            if (
                not (entry.isfile() or entry.isdir())
                or entry.issparse()
                or entry.size < 0
                or name in seen
                or len(seen) >= 4096
                or total > MAX_BYTES
                or not public_archive_member(name, shard)
            ):
                raise ValueError("Unexpected evidence member")
            seen.add(name)
            if not entry.isfile():
                continue
            for index, (prefix, label) in enumerate(OUTPUTS.items()):
                if not name.is_relative_to(prefix):
                    continue
                relative = name.relative_to(prefix)
                if not relative.parts:
                    raise ValueError("Expected file within report directory")
                if index == 0:
                    label += f"-{shard}"
                dst = target / label / relative
                dst.parent.mkdir(parents=True, exist_ok=True)
                stream = archive.extractfile(entry)
                if stream is None:
                    raise ValueError("Missing expected report bytes")
                with stream, dst.open("xb") as output:
                    shutil.copyfileobj(stream, output, 1 << 20)
                if entry.size > 0:
                    populated.add(index)
                break
    if populated != expected:
        raise ValueError("Missing unchanged original report directory")


def unpack(
    bundle: Path,
    target: Path,
    trust: Path,
    *,
    expected: dict,
    now: int,
) -> None:
    if (
        bundle.is_symlink()
        or not bundle.is_file()
        or not 0 < bundle.stat().st_size <= MAX_BYTES
        or target.exists()
        or target.is_symlink()
        or not target.parent.is_dir()
    ):
        raise ValueError("Expected bounded bundle in separately owned job scratch")
    with tempfile.TemporaryDirectory(prefix=".gpu-report-", dir=target.parent) as temp:
        working = Path(temp)
        evidence = working / EVIDENCE
        with zipfile.ZipFile(bundle) as transport:
            info = transport.infolist()
            if len(info) != len(SMALL) + 1 or {i.filename for i in info} != {
                *SMALL,
                EVIDENCE,
            }:
                raise ValueError("Unexpected GPU bundle member")
            values = {}
            for item in info:
                limit = SMALL.get(item.filename, MAX_BYTES)
                if (
                    item.compress_type != zipfile.ZIP_STORED
                    or not 0 < item.file_size <= limit
                ):
                    raise ValueError("Unexpected GPU bundle encoding or size")
                if item.filename in SMALL:
                    values[item.filename] = transport.read(item)
            approval = approved_run(values["approved-run.json"])
            required = {
                "run_id",
                "attempt",
                "check_run_id",
                "workflow_sha",
                "pr_head_sha",
                "source_commit",
                "shard",
                "profile",
            }
            if set(expected) not in (required, required | {"artifact_id"}) or any(
                approval[k] != v for k, v in expected.items()
            ):
                raise ValueError("Return bundle does not match this exact hosted job")
            signature = working / "reply.json.sig"
            signature.write_bytes(values["reply.json.sig"])
            receipt = verify_reply(
                values["request.json"],
                values["reply.json"],
                signature,
                trust,
                expected["workflow_sha"],
                now,
                approval,
            )
            with transport.open(EVIDENCE) as stream, evidence.open("xb") as dst:
                shutil.copyfileobj(stream, dst, 1 << 20)
        with evidence.open("rb") as file:
            if (
                hashlib.file_digest(file, "sha256").hexdigest()
                != receipt["archive_sha256"]
            ):
                raise ValueError("Native report archive bytes differ from signed reply")
        materialized = working / "reports"
        materialized.mkdir(mode=0o700)
        reports(evidence, materialized, approval["shard"])
        materialized.rename(target)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--trust", type=Path, required=True)
    for name in ("run-id", "attempt", "check-run-id", "shard"):
        parser.add_argument("--" + name, type=int, required=True)
    parser.add_argument("--artifact-id", type=int)
    for name in ("workflow-sha", "pr-head-sha", "source-commit", "profile"):
        parser.add_argument("--" + name, required=True)
    args = vars(parser.parse_args())
    if args["artifact_id"] is None:
        args.pop("artifact_id")
    bundle, target, trust = (args.pop(name) for name in ("bundle", "target", "trust"))
    try:
        unpack(bundle, target, trust, expected=args, now=int(time.time()))
    except (ValueError, OSError, tarfile.TarError, zipfile.BadZipFile):
        parser.exit(1, "Missing or invalid exact native GPU result\n")


if __name__ == "__main__":
    main()
