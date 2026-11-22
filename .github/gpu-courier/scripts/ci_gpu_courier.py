"""Verify an explicitly scoped shadow relay reply without running a host command."""

import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path
from typing import Any

from scripts.ci_gpu_fixture import digest, object_field, validate_renderers
from scripts.ci_gpu_guest import (
    CERTIFIED_SITE,
    CERTIFIED_SOURCE,
    approval_digest,
    approved_run,
)

REPOSITORY_ID = 736904496
SIGNATURE_NAMESPACE = "ski-ci-gpu-courier-v1"
SIGNER = "ski-ci-gpu-qualified-operator"
MAX_RELAY_BYTES = 16 * 1024
MAX_LEASE_SECONDS = 60 * 60
CASES = {
    1: (76, "ae356917d25c99d8a0cbe2128fbc8715d3a12d38b5a416a6527e67b83d3a98ba"),
    2: (31, "4ca2a663072cb711df23aa605cb22435882a8fee5e9bbbb5f8f3b3f4f2d36d75"),
}
INT_FIELDS = {"schema", "repository_id", "run_id", "job_id", "attempt", "iat", "exp"}
REQUEST_FIELDS = INT_FIELDS | {
    "workflow_sha",
    "source_commit",
    "site_sha256",
    "profile",
    "shard",
    "nonce",
}
REPLY_FIELDS = {
    "schema",
    "request_sha256",
    "case_digest",
    "cases",
    "archive_sha256",
    "executed",
    "renderers",
    "checks",
}


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Repeated relay field")
        result[key] = value
    return result


def read_bounded(path: Path) -> bytes:
    if not path.is_file() or path.is_symlink():
        raise ValueError("Relay files must be regular files")
    with path.open("rb") as file:
        data = file.read(MAX_RELAY_BYTES + 1)
    if len(data) > MAX_RELAY_BYTES:
        raise ValueError("Relay message exceeds size limit")
    return data


def validate_request(
    raw: bytes, workflow_sha: str, now: int, approval: dict | None = None
) -> dict:
    if not 0 < len(raw) <= MAX_RELAY_BYTES:
        raise ValueError("Relay request exceeds size limit")
    item = object_field(json.loads(raw, object_pairs_hook=unique_object), "request")
    fields = (
        REQUEST_FIELDS | {"approval_sha256"} if approval is not None else REQUEST_FIELDS
    )
    if item.keys() != fields:
        raise ValueError("Reject unknown relay request fields")
    if any(type(item[field]) is not int or item[field] < 1 for field in INT_FIELDS):
        raise ValueError("Expected positive job and lease identifiers")
    shard = item["shard"]
    profile = item["profile"]
    if (
        item["schema"] != (2 if approval is not None else 1)
        or (
            approval is not None
            and item["approval_sha256"] != approval_digest(approval)
        )
        or item["repository_id"] != REPOSITORY_ID
        or item["workflow_sha"] != workflow_sha
        or not digest(workflow_sha, 40)
        or item["source_commit"]
        != (approval["source_commit"] if approval else CERTIFIED_SOURCE)
        or item["site_sha256"]
        != (approval["site_sha256"] if approval else CERTIFIED_SITE)
        or (
            approval
            and any(
                item[k] != approval[k]
                for k in (
                    "workflow_sha",
                    "run_id",
                    "job_id",
                    "attempt",
                    "shard",
                    "profile",
                )
            )
        )
        or type(shard) is not int
        or shard not in CASES
        or profile not in ("intel", "t4")
        or not digest(item["nonce"], 64)
        or not 0 < item["exp"] - item["iat"] <= MAX_LEASE_SECONDS
        or not item["iat"] <= now <= item["exp"]
    ):
        raise ValueError("Wrong exact workflow, fixture, device, or expired lease")
    return item


def verify_reply(
    request: bytes,
    reply: bytes,
    signature: Path,
    trust: Path,
    workflow_sha: str,
    now: int,
    approval: dict | None = None,
) -> dict:
    selected = validate_request(request, workflow_sha, now, approval)
    if len(reply) > MAX_RELAY_BYTES or not read_bounded(signature):
        raise ValueError("Invalid signed relay data")
    result = subprocess.run(
        [
            "ssh-keygen",
            "-Y",
            "verify",
            "-f",
            str(trust),
            "-I",
            SIGNER,
            "-n",
            SIGNATURE_NAMESPACE,
            "-s",
            str(signature),
        ],
        input=reply,
        capture_output=True,
        check=False,
        timeout=5,
    )
    if result.returncode:
        raise ValueError("Untrusted shadow GPU reply")
    reply_data = object_field(
        json.loads(reply, object_pairs_hook=unique_object), "reply"
    )
    if reply_data.keys() != REPLY_FIELDS:
        raise ValueError("Reject unknown relay reply fields")
    shard = selected["shard"]
    count, case_digest = CASES[shard]
    checks = {"browser": "passed"}
    if shard == 1:
        checks |= {"active-gap": "passed", "tilt": "passed"}
    if (
        type(reply_data["schema"]) is not int
        or reply_data["schema"] != selected["schema"]
        or reply_data["request_sha256"] != hashlib.sha256(request).hexdigest()
        or not digest(reply_data["archive_sha256"], 64)
        or type(reply_data["cases"]) is not int
        or reply_data["cases"] != count
        or reply_data["case_digest"] != case_digest
        or reply_data["checks"] != checks
        or type(reply_data["executed"]) is not int
        or not selected["iat"] <= reply_data["executed"] <= now
    ):
        raise ValueError("Reply does not prove the exact requested original workload")
    validate_renderers(selected["profile"], reply_data["renderers"])
    return reply_data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("reply", type=Path)
    parser.add_argument("--signature", type=Path, required=True)
    parser.add_argument("--trust", type=Path, required=True)
    parser.add_argument("--workflow-sha", required=True)
    parser.add_argument("--approved-run", type=Path)
    args = parser.parse_args()
    try:
        reply = verify_reply(
            read_bounded(args.request),
            read_bounded(args.reply),
            args.signature,
            args.trust,
            args.workflow_sha,
            int(time.time()),
            approved_run(read_bounded(args.approved_run))
            if args.approved_run
            else None,
        )
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"GPU reply not accepted: {error}\n")
    print(f"Verified {reply['cases']} original hardware browser cases")


if __name__ == "__main__":
    main()
