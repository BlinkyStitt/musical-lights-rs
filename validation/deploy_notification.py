"""Send one best-effort ntfy result for a completed main workflow attempt."""

import json
import os
import urllib.request


def notification(needs, commit, latest, repository, run_url):
    results = {name: job["result"] for name, job in needs.items()}
    if "cancelled" in results.values():
        return None
    pages = needs["pages"]
    url = pages.get("outputs", {}).get("page_url", "")
    deployed = pages.get("outputs", {}).get("deployed") == "true" and bool(url)
    if not deployed and commit != latest:
        return None
    failed = [name for name, result in results.items() if result == "failure"]
    if not failed and not deployed:
        return None
    status = "deployed" if deployed else "not deployed"
    title = "Musical Lights deployed"
    if failed:
        title = (
            "Musical Lights deployed; validation failed"
            if deployed
            else ("Musical Lights validation/deployment failed")
        )
    lines = [
        f"Site: {status}",
        f"Commit: https://github.com/{repository}/commit/{commit}",
    ]
    if deployed:
        lines.append(f"Website: {url}")
    if failed:
        lines.append("Failed jobs: " + ", ".join(failed))
    lines.append(f"Workflow: {run_url}")
    return {
        "title": title,
        "message": "\n".join(lines),
        "priority": 4 if failed else 3,
        "tags": ["x" if failed else "white_check_mark"],
        "click": run_url if failed else url,
    }


def main():
    env = os.environ
    message = notification(
        json.loads(env["JOB_RESULTS"]),
        env["GITHUB_SHA"],
        env["LATEST_SHA"],
        env["GITHUB_REPOSITORY"],
        f"{env['GITHUB_SERVER_URL']}/{env['GITHUB_REPOSITORY']}/actions/runs/"
        f"{env['GITHUB_RUN_ID']}/attempts/{env['GITHUB_RUN_ATTEMPT']}",
    )
    if message is None:
        print("No deployment notification for this attempt.")
        return
    try:
        if not all(env.get(key) for key in ("NTFY_URL", "NTFY_TOPIC", "NTFY_TOKEN")):
            raise ValueError("Notification configuration is missing")
        message["topic"] = env["NTFY_TOPIC"]
        request = urllib.request.Request(
            env["NTFY_URL"],
            data=json.dumps(message).encode(),
            headers={
                "Authorization": f"Bearer {env['NTFY_TOKEN']}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=15):
            pass
        summary = "Deployment notification accepted by ntfy."
    except (OSError, ValueError):
        # Do not print URLs, credentials, request bodies, or response bodies.
        summary = "Deployment notification failed; deployment results are unchanged."
        print(f"::warning::{summary}")
    with open(env["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write(summary + "\n")


if __name__ == "__main__":
    main()
