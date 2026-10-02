"""Publish one content-addressed runtime and the static CSR route entries."""

import hashlib
import json
import os
import re
import shutil
from pathlib import Path


def publish(staging: Path) -> str:
    # Include glue snippets, worker imports, WASM, CSS and icons in one namespace.
    # Relative imports stay untouched, including wasm-bindgen's stable snippets.
    entries = sorted(p for p in staging.iterdir() if p.name != "index.html")
    html = (staging / "index.html").read_text()
    bootstrap = (Path(__file__).parent / "bootstrap.js").read_text()
    digest = hashlib.sha256((html + bootstrap).encode())
    for entry in entries:
        files = sorted(entry.rglob("*")) if entry.is_dir() else [entry]
        for file in files:
            if file.is_file():
                digest.update(file.relative_to(staging).as_posix().encode())
                digest.update(b"\0")
                digest.update(hashlib.sha256(file.read_bytes()).digest())
    version = digest.hexdigest()[:24]
    base = re.search(r'<base href="([^"]+)"', html)
    if base is None:
        raise ValueError("Trunk did not emit a public base URL")
    public = base[1]
    assets = f"{public}assets/{version}/"
    target = staging / "assets" / version
    target.mkdir(parents=True)
    for entry in entries:
        # Rewrite only URL boundaries, never canonical/share URLs or prose.
        html = re.sub(
            r"([\"'])" + re.escape(public + entry.name) + r"(?=[/\"'])",
            lambda match, name=entry.name: match[1] + assets + name,
            html,
        )
        shutil.move(str(entry), target / entry.name)
    html = html.replace(
        "</head>", f'<meta name="musical-lights-assets" content="{assets}" /></head>'
    )
    # Check the entry document before importing any application code. GitHub Pages
    # caches HTML too; a stale entry must navigate to the current version, not mix
    # old glue with newly deployed modules. A failed/offline check still boots its
    # coherent cached runtime. Never reload an active microphone session.
    html, count = re.subn(
        r"import init, \* as bindings from ('[^']+');",
        lambda match: (
            bootstrap.replace("__BUILD__", version)
            + f"\nconst {{ default: init, ...bindings }} = await import({match[1]});"
        ),
        html,
    )
    if count != 1:
        raise ValueError("Expected exactly one Trunk application bootstrap")
    (staging / "index.html").write_text(html)
    (staging / "build.json").write_text(json.dumps({"version": version}))
    for relative in ("about/index.html", "advanced/index.html", "404.html"):
        destination = staging / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(staging / "index.html", destination)
    # Social crawlers use the permanent URL in the document's share metadata.
    shutil.copyfile(target / "social-preview.png", staging / "social-preview.png")
    return version


def main() -> None:
    publish(Path(os.environ["TRUNK_STAGING_DIR"]))


if __name__ == "__main__":
    main()
