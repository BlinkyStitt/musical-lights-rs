"""Plan affected jobs and verify content-addressed website validation artifacts."""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = (
    "musical-leptos/dist",
    "musical-lights-physics/pkg",
    "musical-lights-worklet/pkg",
)
VALIDATORS = {
    "Site plan",
    "rust (core)",
    "loudness-reference",
    "Build website",
    "Browser (chromium-1)",
    "Browser (chromium-2)",
    "Browser (webkit)",
    "Validated website",
}


def git(*args, root=ROOT):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def api(repository, path):
    return json.loads(
        subprocess.check_output(["gh", "api", f"repos/{repository}/{path}"], text=True)
    )


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs(root=ROOT):
    return {
        "source_tree": git("rev-parse", "HEAD^{tree}", root=root),
        "workflow": sha(root / ".github/workflows/validate.yml"),
        "runner_os": os.environ.get("RUNNER_OS", platform.system()),
        "runner_arch": os.environ.get("RUNNER_ARCH", platform.machine()),
        "runner_image": os.environ.get("ImageOS", "local"),
    }


def files(bundle):
    result = {}
    for path in sorted(bundle.rglob("*")):
        if path.is_symlink():
            raise ValueError("Artifact contains a symbolic link")
        if path.is_file() and path != bundle / "provenance.json":
            result[path.relative_to(bundle).as_posix()] = sha(path)
    return result


def verify(bundle, expected, run_id):
    manifest = json.loads((bundle / "provenance.json").read_text())
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != 1
        or manifest.get("inputs") != expected
    ):
        raise ValueError("Artifact source tree or build inputs do not match")
    if str(manifest.get("run_id")) != str(run_id):
        raise ValueError("Artifact producer does not match the successful run")
    actual = files(bundle)
    if actual != manifest["files"] or not actual:
        raise ValueError("Artifact digest or file inventory does not match")
    for name in actual:
        if name != "inventory.json" and not any(
            name.startswith(p + "/") for p in PAYLOAD
        ):
            raise ValueError("Artifact contains an unexpected path")
    if "inventory.json" not in actual or any(
        not any(name.startswith(p + "/") for name in actual) for p in PAYLOAD
    ):
        raise ValueError("Artifact payload is incomplete")
    return manifest


def pack(bundle, inventory, root=ROOT):
    if git("status", "--porcelain", root=root):
        raise ValueError("Cannot publish validation for a dirty source tree")
    bundle.mkdir(parents=True, exist_ok=False)
    for name in PAYLOAD:
        shutil.copytree(root / name, bundle / name)
    shutil.copyfile(inventory, bundle / "inventory.json")
    repository = os.environ["GITHUB_REPOSITORY"]
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    event = json.loads(Path(event_path).read_text()) if event_path else {}
    head_repository = (
        event.get("pull_request", {})
        .get("head", {})
        .get("repo", {})
        .get("full_name", repository)
    )
    manifest = {
        "schema": 1,
        "inputs": inputs(root),
        "run_id": os.environ["GITHUB_RUN_ID"],
        "run_attempt": int(os.environ.get("GITHUB_RUN_ATTEMPT", "1")),
        "repository": repository,
        "head_repository": head_repository,
        "source_commit": git("rev-parse", "HEAD", root=root),
        "files": files(bundle),
    }
    (bundle / "provenance.json").write_text(json.dumps(manifest, sort_keys=True))


def unpack(bundle, run_id, root=ROOT):
    verify(bundle, inputs(root), run_id)
    for name in PAYLOAD:
        destination = root / name
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(bundle / name, destination)


def test_cases(report):
    result = []

    def walk(suite):
        for spec in suite.get("specs", []):
            for test in spec["tests"]:
                result.append((spec["id"], test["projectName"], test))
        for child in suite.get("suites", []):
            walk(child)

    for suite in report["suites"]:
        walk(suite)
    return result


def coverage(inventory, reports):
    expected = [case[:2] for case in test_cases(json.loads(inventory.read_text()))]
    actual = []
    for report in reports:
        document = json.loads(report.read_text())
        if document.get("errors") or document["stats"]["unexpected"]:
            raise ValueError("Browser report contains a failure")
        for test_id, project, test in test_cases(document):
            results = test.get("results", [])
            if len(results) != 1 or test.get("status") not in ("expected", "skipped"):
                raise ValueError("Browser test did not complete exactly once")
            if results[0]["status"] not in (test["expectedStatus"], "skipped"):
                raise ValueError(
                    "Browser test result does not match its expected status"
                )
            actual.append((test_id, project))
    if not expected or len(expected) != len(set(expected)):
        raise ValueError("Expected test inventory is empty or contains duplicates")
    if len(actual) != len(set(actual)) or set(actual) != set(expected):
        raise ValueError("Browser shards omitted or duplicated tests")
    print(f"All {len(expected)} scheduled browser tests ran exactly once.")


def download(repository, run, directory):
    subprocess.run(
        [
            "gh",
            "run",
            "download",
            str(run["id"]),
            "--repo",
            repository,
            "--name",
            run["artifact_name"],
            "--dir",
            str(directory),
        ],
        check=True,
    )


def reusable(repository, expected, read=api, fetch=download):
    workflow = read(repository, "actions/workflows/validate.yml")
    name = f"validated-site-{expected['source_tree']}"
    artifacts = read(repository, f"actions/artifacts?name={name}&per_page=100")[
        "artifacts"
    ]
    for artifact in artifacts:
        if artifact["expired"] or artifact["name"] != name:
            continue
        run = read(repository, f"actions/runs/{artifact['workflow_run']['id']}")
        if (
            run["head_repository"]["full_name"] != repository
            or run["path"] != ".github/workflows/validate.yml"
            or run["workflow_id"] != workflow["id"]
            or run["event"] != "pull_request"
            or run["status"] != "completed"
            or run["conclusion"] != "success"
        ):
            continue
        jobs = read(
            repository,
            f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100",
        )["jobs"]
        passed = {job["name"] for job in jobs if job["conclusion"] == "success"}
        if not VALIDATORS.issubset(passed):
            continue
        with tempfile.TemporaryDirectory() as directory:
            try:
                fetch(repository, {**run, "artifact_name": name}, Path(directory))
                manifest = verify(Path(directory), expected, run["id"])
                if (
                    manifest["repository"] != repository
                    or manifest["head_repository"] != repository
                ):
                    raise ValueError("Artifact came from a different repository")
                commit = manifest["source_commit"]
                if (
                    not isinstance(commit, str)
                    or len(commit) != 40
                    or any(c not in "0123456789abcdef" for c in commit)
                ):
                    raise ValueError("Invalid artifact source commit")
                source = read(repository, f"git/commits/{manifest['source_commit']}")
                if (
                    manifest["run_attempt"] != run["run_attempt"]
                    or source["tree"]["sha"] != expected["source_tree"]
                    or (
                        manifest["source_commit"] != run["head_sha"]
                        and run["head_sha"] not in {p["sha"] for p in source["parents"]}
                    )
                ):
                    raise ValueError(
                        "Artifact commit does not belong to the validated run"
                    )
            except (ValueError, KeyError, OSError, subprocess.CalledProcessError):
                print(
                    "Previous artifact is unavailable or does not match; fresh validation is required."
                )
                continue
        return str(run["id"]), str(artifact["id"])
    return "", ""


def changed_paths(event, root=ROOT):
    if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
        return None
    base = event.get("pull_request", {}).get("base", {}).get("sha") or event.get(
        "before"
    )
    if not base or base == "0" * 40:
        return None
    if len(base) != 40 or any(c not in "0123456789abcdef" for c in base):
        raise ValueError("Invalid base commit")
    exists = subprocess.run(
        ["git", "cat-file", "-e", base], cwd=root, capture_output=True, check=False
    )
    if exists.returncode:
        subprocess.run(
            ["git", "fetch", "--no-tags", "--depth=1", "origin", base],
            cwd=root,
            check=True,
        )
    return git("diff", "--name-only", "-z", base, "HEAD", root=root).split("\0")


def affected(paths, package, workflow):
    if paths is None:
        return True
    shared = (
        "musical-lights-core/",
        "validation/ci.py",
        "validation/validate.py",
        "validation/install_tools.py",
        "validation/tooling/",
        ".cargo/",
    )
    own = (package + "/", f".github/workflows/{workflow}.yml")
    if workflow == "other-apps" and package != "musical-terminal":
        own += (
            "validation/demos.config.mjs",
            "validation/tests/other-apps.spec.mjs",
            "validation/browser-",
            "validation/server.mjs",
            "validation/package",
        )
    return any(
        path.startswith(shared + own)
        or path in ("Cargo.toml", "Cargo.lock")
        or ".cargo" in Path(path).parts
        or Path(path).name.startswith("rust-toolchain")
        for path in paths
    )


def output(values):
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.writelines(
            f"{key}={str(value).lower() if isinstance(value, bool) else value}\n"
            for key, value in values.items()
        )


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan")
    sub.add_parser("changes")
    p = sub.add_parser("pack")
    p.add_argument("bundle", type=Path)
    p.add_argument("inventory", type=Path)
    for command in ("unpack", "verify"):
        p = sub.add_parser(command)
        p.add_argument("bundle", type=Path)
        p.add_argument("run_id")
    p = sub.add_parser("coverage")
    p.add_argument("inventory", type=Path)
    p.add_argument("reports", type=Path)
    args = parser.parse_args()
    if args.command == "plan":
        run_id, artifact = (
            ("", "")
            if os.environ["GITHUB_EVENT_NAME"] == "pull_request"
            else reusable(os.environ["GITHUB_REPOSITORY"], inputs())
        )
        output(
            {
                "reuse": bool(run_id),
                "run_id": run_id,
                "artifact_id": artifact,
                "tree": inputs()["source_tree"],
            }
        )
        summary = (
            f"Reuse verified validation from https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run_id}.\n"
            if run_id
            else "No exact validated artifact exists. Run the complete build and validation.\n"
        )
        print(summary.strip())
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write(summary)
    elif args.command == "changes":
        paths = changed_paths(
            json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        )
        targets = {
            "terminal": ("musical-terminal", "other-apps"),
            "demos": ("musical-dioxus", "other-apps"),
            "feather": ("musical-feather-m0", "firmware"),
            "stm32": ("musical-stm32", "firmware"),
            "esp-embassy": ("musical-adafruit-sparkle-embassy", "firmware"),
            "esp-idf": ("musical-adafruit-sparkle-idf", "firmware"),
        }
        result = {
            name: affected(paths, package, workflow)
            for name, (package, workflow) in targets.items()
        }
        result["demos"] |= affected(paths, "musical-wasm", "other-apps")
        for group, names in (
            ("rust", ("feather", "stm32")),
            ("esp", ("esp-embassy", "esp-idf")),
        ):
            result[group] = any(result[name] for name in names)
            result[group + "_matrix"] = json.dumps(
                {
                    "include": [
                        {"package": name, "directory": targets[name][0]}
                        for name in names
                        if result[name]
                    ]
                }
            )
        output(result)
    elif args.command == "pack":
        pack(args.bundle, args.inventory)
    elif args.command == "unpack":
        unpack(args.bundle, args.run_id)
    elif args.command == "verify":
        verify(args.bundle, inputs(), args.run_id)
    else:
        reports = sorted(args.reports.rglob("report.json"))
        if len(reports) != 3:
            raise ValueError("Expected all three browser reports")
        coverage(args.inventory, reports)


if __name__ == "__main__":
    main()
