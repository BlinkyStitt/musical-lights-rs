"""Require the complete website browser run for this clean, delivered source tree."""

import json
import subprocess
import tempfile
import time
from pathlib import Path

import ci


def command(*args):
    return subprocess.check_output(args, cwd=ci.ROOT, text=True).strip()


def clean_head():
    if ci.git("status", "--porcelain"):
        raise ValueError("Browser CI requires a clean worktree")
    return ci.git("rev-parse", "HEAD")


def select_run(runs, head, number, repository):
    matching = [
        run
        for run in runs
        if run["head_sha"] == head
        and run["event"] == "pull_request"
        and run["head_repository"]["full_name"] == repository
        and any(pr["number"] == number for pr in run["pull_requests"])
    ]
    return max(matching, key=lambda run: run["id"], default=None)


def verify_run(repository, run, head, expected, read=ci.api, fetch=ci.download):
    if run["status"] != "completed" or run["conclusion"] != "success":
        raise ValueError("Website CI did not complete successfully")
    if run["path"] != ".github/workflows/validate.yml" or run["head_sha"] != head:
        raise ValueError("Website CI is for a different workflow or commit")
    jobs = read(
        repository,
        f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100",
    )["jobs"]
    for name in ci.VALIDATORS:
        matches = [job for job in jobs if job["name"] == name]
        if len(matches) != 1 or matches[0]["conclusion"] != "success":
            raise ValueError(
                f"Required website job did not succeed exactly once: {name}"
            )
    artifact_name = f"validated-site-{expected['source_tree']}"
    with tempfile.TemporaryDirectory() as directory:
        fetch(repository, {**run, "artifact_name": artifact_name}, Path(directory))
        manifest = ci.verify(Path(directory), expected, run["id"])
        if (
            manifest["repository"] != repository
            or manifest["head_repository"] != repository
            or manifest["run_attempt"] != run["run_attempt"]
        ):
            raise ValueError("Website artifact producer does not match this run")
        source = read(repository, f"git/commits/{manifest['source_commit']}")
        if source["tree"]["sha"] != expected["source_tree"] or (
            manifest["source_commit"] != head
            and head not in {parent["sha"] for parent in source["parents"]}
        ):
            raise ValueError(
                "Website artifact did not test this commit and source tree"
            )


def main():
    head = clean_head()
    repository = json.loads(command("gh", "repo", "view", "--json", "nameWithOwner"))[
        "nameWithOwner"
    ]
    pr = json.loads(
        command(
            "gh",
            "pr",
            "view",
            "--json",
            "number,headRefOid,headRepository,headRepositoryOwner",
        )
    )
    head_repository = (
        f"{pr['headRepositoryOwner']['login']}/{pr['headRepository']['name']}"
    )
    if pr["headRefOid"] != head or head_repository != repository:
        raise ValueError(
            "Pull request must publish this exact commit in the same repository"
        )
    expected = ci.inputs()
    expected.update(runner_os="Linux", runner_arch="X64")
    print(
        f"Waiting for complete website CI for {repository} PR #{pr['number']} at {head}",
        flush=True,
    )
    deadline = time.monotonic() + 45 * 60
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError("Website CI did not finish within 45 minutes")
        runs = ci.api(
            repository,
            f"actions/workflows/validate.yml/runs?event=pull_request&head_sha={head}&per_page=100",
        )["workflow_runs"]
        run = select_run(runs, head, pr["number"], repository)
        if run and run["status"] == "completed":
            verify_run(repository, run, head, expected)
            break
        time.sleep(10)
    if clean_head() != head:
        raise ValueError("Worktree commit changed while waiting for website CI")
    current = json.loads(
        command("gh", "pr", "view", str(pr["number"]), "--json", "headRefOid")
    )
    if current["headRefOid"] != head:
        raise ValueError("Pull request head changed while waiting for website CI")
    print(
        f"Complete website browser CI passed: https://github.com/{repository}/actions/runs/{run['id']}"
    )


if __name__ == "__main__":
    main()
