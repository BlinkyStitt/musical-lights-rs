# Dioxus application

- Check the installed Dioxus version in `Cargo.toml` and `Cargo.lock` before using APIs.
  For 0.7 code, use signals and current component APIs; do not introduce `cx`, `Scope`,
  or `use_state`.
- Keep component props owned and compatible with the installed `Clone`/`PartialEq`
  requirements. Use reactive props when dependent memos/resources must rerun.
- For server-rendered routes, keep initial server and client output identical. Use
  the supported server-future hook for initial data; access browser-only APIs after
  hydration in an effect.
- Use `asset!` for bundled assets and the installed router/fullstack features when
  changing those surfaces. Follow existing entrypoints and Cargo feature selections.
- From the repository root, validate this app with
  `python3 validation/validate.py dioxus` using `.tools/bin` on `PATH`. Follow the
  parent [validation instructions](../AGENTS.md) for browser or deployment checks.
