"""Deployment regressions for the complete runtime dependency graph."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "publish_routes",
    Path(__file__).resolve().parents[2] / "musical-leptos/publish_routes.py",
)
assert spec is not None and spec.loader is not None
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
publish = publisher.publish


class PublishTests(unittest.TestCase):
    def fixture(self, root: Path, public: str = "/") -> None:
        files = {
            "app.js": "import './snippets/pkg/src/input.js';",
            "app.wasm": "app wasm",
            "snippets/pkg/src/input.js": "input v1",
            "physics/view.js": "import './worker.js';",
            "physics/worker.js": "import './physics.js';",
            "physics/physics.js": "new URL('physics_bg.wasm', import.meta.url);",
            "physics/physics_bg.wasm": "physics v1",
            "loudness/processor.js": "processor v1",
            "loudness/loudness.wasm": "audio v1",
            "styles.css": "body {}",
            "social-preview.png": "image",
        }
        for name, content in files.items():
            p = root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        (root / "index.html").write_text(
            f'<head><base href="{public}" />'
            f'<link href="{public}styles.css" />'
            f'<link href="{public}snippets/pkg/src/input.js" />'
            f"<script type=\"module\">import init, * as bindings from '{public}app.js';"
            f"await init({{ module_or_path: '{public}app.wasm' }});</script></head>"
        )

    def test_all_dependencies_and_route_entries_share_one_version(self) -> None:
        for public in ("/", "/project/"):
            with self.subTest(public=public), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                self.fixture(root, public)
                version = publish(root)
                runtime = root / "assets" / version
                html = (root / "index.html").read_text()
                for name in (
                    "app.js",
                    "app.wasm",
                    "snippets/pkg/src/input.js",
                    "styles.css",
                ):
                    self.assertIn(f"{public}assets/{version}/{name}", html)
                    self.assertTrue((runtime / name).is_file())
                    self.assertFalse((root / name).exists())
                self.assertIn(f'content="{public}assets/{version}/"', html)
                self.assertEqual(
                    (runtime / "physics/view.js").read_text(), "import './worker.js';"
                )
                self.assertEqual(
                    (runtime / "physics/physics_bg.wasm").read_text(), "physics v1"
                )
                self.assertEqual(
                    json.loads((root / "build.json").read_text()), {"version": version}
                )
                for route in ("about/index.html", "advanced/index.html", "404.html"):
                    self.assertEqual((root / route).read_text(), html)
                self.assertTrue((root / "social-preview.png").is_file())

    def test_any_changed_transitive_module_changes_runtime_urls(self) -> None:
        def build(changed: str = "") -> str:
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                self.fixture(root)
                if changed:
                    file = root / changed
                    file.write_text(
                        file.read_text() + "\n<!-- changed entry -->"
                        if changed == "index.html"
                        else "changed content"
                    )
                return publish(root)

        before = build()
        self.assertEqual(before, build())
        for changed in (
            "snippets/pkg/src/input.js",
            "physics/worker.js",
            "physics/physics_bg.wasm",
            "loudness/processor.js",
            "loudness/loudness.wasm",
            "app.wasm",
            "index.html",
        ):
            with self.subTest(changed=changed):
                self.assertNotEqual(before, build(changed))


if __name__ == "__main__":
    unittest.main()
