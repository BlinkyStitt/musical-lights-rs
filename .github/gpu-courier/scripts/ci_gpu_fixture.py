"""Minimal pinned public GPU report verifier dependency."""

import re
from typing import Any

PROFILES = {"intel": r"virgl.*intel", "t4": r"virgl.*tesla t4"}

SOFTWARE = re.compile(r"llvmpipe|softpipe|swiftshader|software", re.IGNORECASE)

def object_field(value: Any, label: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value

def digest(value: Any, length: int) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(f"[0-9a-f]{{{length}}}", value))

def validate_renderers(profile: str, renderers: Any) -> None:
    evidence = object_field(renderers, "renderers")
    if evidence.keys() != {"glx", "webgl"}:
        raise ValueError("Require both GLX and browser WebGL renderer evidence")
    if any(
        not isinstance(renderer, str)
        or SOFTWARE.search(renderer)
        or not re.search(PROFILES[profile], renderer, re.IGNORECASE)
        for renderer in evidence.values()
    ):
        raise ValueError("Renderer does not match required hardware VirGL profile")
