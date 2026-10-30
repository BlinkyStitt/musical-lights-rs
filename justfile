export PATH := justfile_directory() + "/.tools/bin:" + env("PATH")

# Validate all apps locally, including complete browser and hardware acceptance.
# Run on an idle GPU host: timing variants execute serially after browser checks.
check: validate
    python3 validation/validate.py browser
    .tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.gpu.config.mjs
    just validate-tilt

# Collect both renderer comparisons serially against one already-built artifact.
# A missing GPU, incomplete samples or mismatched provenance fails this recipe.
validate-tilt:
    mkdir -p .ci/tilt-lighting
    rm -f .ci/tilt-lighting/software.json .ci/tilt-lighting/software.json.failure.json .ci/tilt-lighting/hardware.json .ci/tilt-lighting/hardware.json.failure.json .ci/tilt-lighting/comparison.md
    node validation/tilt-lighting-timing.mjs .ci/tilt-lighting/software.json
    node validation/tilt-lighting-timing.mjs .ci/tilt-lighting/hardware.json --hardware
    node validation/tilt-lighting-comparison.mjs .ci/tilt-lighting/software.json .ci/tilt-lighting/hardware.json .ci/tilt-lighting/comparison.md

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
