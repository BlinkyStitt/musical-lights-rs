"""Build the shared rigid-body simulation and locally bundled renderer assets."""

import shutil
import subprocess
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parent
    repo = root.parent
    web = repo / "musical-leptos"
    subprocess.run(
        [
            "cargo",
            "+nightly-2026-09-10",
            "build",
            "--locked",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
        ],
        cwd=root,
        check=True,
    )
    output = root / "pkg"
    output.mkdir(exist_ok=True)
    subprocess.run(
        [
            "wasm-bindgen",
            "--target",
            "web",
            "--out-dir",
            str(output),
            "--out-name",
            "physics",
            str(
                root
                / "target/wasm32-unknown-unknown/release/musical_lights_physics.wasm"
            ),
        ],
        check=True,
    )
    subprocess.run(
        ["npm", "ci", "--ignore-scripts", "--cache", str(repo / ".cache/npm")],
        cwd=web,
        check=True,
    )
    for name in ("three.module.js", "three.core.js"):
        shutil.copyfile(web / "node_modules/three/build" / name, output / name)
    shutil.copyfile(web / "node_modules/three/LICENSE", output / "THREE-LICENSE.txt")
    shutil.copyfile(
        repo / "licenses/Apache-2.0-Rapier.txt", output / "RAPIER-LICENSE.txt"
    )
    # The official geometry module uses a bare import. Resolve it to our pinned local copy.
    geometry = (
        web / "node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js"
    ).read_text()
    (output / "RoundedBoxGeometry.js").write_text(
        geometry.replace("from 'three'", "from './three.module.js'")
    )
    shutil.copyfile(root / "worker.js", output / "worker.js")
    for name in ("view.js", "report.js"):
        shutil.copyfile(web / "src/physics" / name, output / name)
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repo, text=True
    ).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=repo))
    (output / "build.js").write_text(
        f"export const build = '{commit}{'-dirty' if dirty else ''}';\n"
    )


if __name__ == "__main__":
    main()
