export PATH := justfile_directory() + "/.tools/bin:" + env("PATH")

# Validate the shared core and website, including offline and browser checks.
check:
    python3 validation/validate.py core worklet physics leptos
    npm --prefix validation ci --ignore-scripts
    cd validation && npx playwright install chromium webkit
    npm --prefix validation run test:site
