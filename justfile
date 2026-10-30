export PATH := justfile_directory() + "/.tools/bin:" + env("PATH")

# Validate all apps locally, including complete browser and hardware acceptance.
# Run on an idle GPU host: timing variants execute serially after browser checks.
check: validate
    python3 validation/validate.py browser
    mkdir -p .ci/tilt-lighting
    node validation/tilt-lighting-timing.mjs .ci/tilt-lighting/software.json
    .tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.gpu.config.mjs
    node validation/tilt-lighting-timing.mjs .ci/tilt-lighting/hardware.json --hardware

# Verify delivered, exact-commit CI and run local demo checks.
check-ci:
    .tools/bin/actionlint .github/workflows/*.yml
    python3 -m unittest discover -s validation/tooling -v
    python3 validation/validate.py core worklet physics leptos benchmarks dioxus wasm
    python3 validation/ci_browser.py
    cd validation && npm ci --ignore-scripts && npx playwright install chromium && node --test harness/*.test.mjs && npm run test:demos

# Run CPU-only validation. GitHub runs the complete browser suite and GPU checks.
validate:
    .tools/bin/actionlint .github/workflows/*.yml
    python3 -m unittest discover -s validation/tooling -v
    python3 validation/validate.py core worklet physics leptos benchmarks dioxus wasm
    cd validation && npm ci --ignore-scripts && node --test harness/*.test.mjs

# Run the hardware-rendered browser checks against the already-built site.
validate-gpu *args:
    cd validation && npm ci --ignore-scripts && npx playwright install chromium && npx playwright test --config playwright.gpu.config.mjs {{args}}
