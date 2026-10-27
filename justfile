export PATH := justfile_directory() + "/.tools/bin:" + env("PATH")

# Validate the shared core and all web apps, including offline and browser checks.
check:
    python3 validation/validate.py core worklet physics leptos benchmarks dioxus wasm
    python3 validation/validate.py browser

# Retain the camera-controls acceptance entry point with the same complete checks.
alias validate := check
