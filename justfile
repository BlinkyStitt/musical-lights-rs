export PATH := justfile_directory() + "/.tools/bin:" + env("PATH")

# Validate CI contracts, the shared core and all web apps, including browser checks.
check:
    .tools/bin/actionlint .github/workflows/*.yml
    python3 -m unittest discover -s validation/tooling -v
    python3 validation/validate.py core worklet physics leptos benchmarks dioxus wasm
    python3 validation/validate.py browser

# Retain the camera-controls acceptance entry point with the same complete checks.
alias validate := check
