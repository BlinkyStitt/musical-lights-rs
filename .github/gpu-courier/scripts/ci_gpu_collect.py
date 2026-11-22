"""Minimal pinned public GPU report verifier dependency."""

from pathlib import PurePosixPath

LOGS = {
    "evidence/glx.log",
    "evidence/site.log",
    "evidence/browser.log",
    "evidence/webgl.txt",
}

LONG_LOGS = {"evidence/active-gap.log", "evidence/tilt.log"}

BENCHMARKS = {
    PurePosixPath("source/.ci/active-gap"),
    PurePosixPath("source/.ci/tilt-lighting"),
}

def public_archive_member(name: PurePosixPath, shard: int) -> bool:
    if name.is_absolute() or ".." in name.parts:
        return False
    if str(name) in LOGS or name.is_relative_to("source/validation/test-results"):
        return True
    return shard == 1 and (
        str(name) in LONG_LOGS or any(name.is_relative_to(p) for p in BENCHMARKS)
    )
