"""Publish the CSR entry document at routes that static hosting must serve."""

import os
import shutil
from pathlib import Path


def main() -> None:
    staging = Path(os.environ["TRUNK_STAGING_DIR"])
    # Keep non-root page entries aligned with App's routes in src/lib.rs.
    # The fallback starts the same router at unknown URLs, retaining HTTP 404.
    for relative in ("about/index.html", "404.html"):
        destination = staging / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(staging / "index.html", destination)


if __name__ == "__main__":
    main()
