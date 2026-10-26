# Run from the repository root. Missing pinned tools or rendered artifacts fail.
validate:
    .tools/bin/node --eval "if (process.version !== 'v26.8.2') throw new Error('Expected pinned Node v26.8.2');"
    PATH="{{justfile_directory()}}/.tools/bin:$PATH" python3 validation/validate.py core physics worklet leptos benchmarks dioxus wasm browser
