export PATH := justfile_directory() + "/.tools/bin:" + env("PATH")

# Validate the shared core and all web apps, including offline and browser checks.
check:
    python3 validation/validate.py core worklet physics leptos dioxus wasm
    python3 validation/validate.py browser
