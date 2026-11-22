"""Minimal pinned public GPU report verifier dependency."""

import hashlib
import json
import re

CERTIFIED_SOURCE = "f0a3b0b5e39e0f549daed3e105fbf4318cfd079a"

CERTIFIED_SITE = "5d5729ec3ab877bd98d32381422c1fa05bbfc26ae6893714f9bdf826c0d3f873"

APPROVAL_FIELDS = {
    "repository_id",
    "run_id",
    "attempt",
    "job_id",
    "check_run_id",
    "workflow_sha",
    "pr_head_sha",
    "source_commit",
    "source_sha256",
    "site_sha256",
    "site_payload_sha256",
    "producer_run_id",
    "producer_attempt",
    "artifact_id",
    "profile",
    "shard",
}

ID_FIELDS = {
    "repository_id",
    "run_id",
    "attempt",
    "job_id",
    "check_run_id",
    "producer_run_id",
    "producer_attempt",
    "artifact_id",
    "shard",
}

def approval_bytes(rule: dict) -> bytes:
    return json.dumps(rule, sort_keys=True, separators=(",", ":")).encode("ascii")

def approval_digest(rule: dict) -> str:
    return hashlib.sha256(approval_bytes(rule)).hexdigest()

def approved_run(raw: bytes) -> dict:
    """Validate an independently generated, trusted operator input, not a claim."""

    def unique(pairs):
        d = dict(pairs)
        if len(d) != len(pairs):
            raise ValueError("Duplicate approved-run field")
        return d

    if not 0 < len(raw) <= 4096:
        raise ValueError("Approved-run record size")
    rule = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(rule, dict) or set(rule) not in (
        APPROVAL_FIELDS,
        APPROVAL_FIELDS | {"resource_class"},
    ):
        raise ValueError("Approved-run record schema")
    if "resource_class" in rule and rule["resource_class"] not in (
        "small",
        "medium",
        "large",
    ):
        raise ValueError("Unrecognized approved host resource class")
    if raw != approval_bytes(rule):
        raise ValueError("Require exact canonical approved-run bytes")
    if any(type(rule[n]) is not int or not 0 < rule[n] < 2**63 for n in ID_FIELDS):
        raise ValueError("Exact positive provider IDs required")
    if (
        rule["repository_id"] != 736904496
        or rule["producer_run_id"] != rule["run_id"]
        or rule["producer_attempt"] > rule["attempt"]
        or rule["profile"] not in ("intel", "t4")
        or rule["shard"] not in (1, 2)
    ):
        raise ValueError("Reject external producer, repo or GPU shape")
    for name in (
        "workflow_sha",
        "pr_head_sha",
        "source_commit",
        "source_sha256",
        "site_sha256",
        "site_payload_sha256",
    ):
        length = 40 if name in {"workflow_sha", "pr_head_sha", "source_commit"} else 64
        if not isinstance(rule[name], str) or not re.fullmatch(
            rf"[a-f0-9]{{{length}}}", rule[name]
        ):
            raise ValueError("Exact approved-run digest required")
    if rule["pr_head_sha"] == rule["source_commit"]:
        raise ValueError("Test the exact synthetic merge, not the raw PR head")
    return rule
