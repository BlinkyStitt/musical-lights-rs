# Browser validation

- Run validation commands from the repository root.
- Use the pinned tools in `.tools/bin`. Add that directory to `PATH` before
  running `python3 validation/validate.py leptos` or browser validation.
- Use host access (`sandbox_permissions: "require_escalated"`) for browser
  checks on macOS. Use `python3 validation/validate.py browser` for the full
  browser suite. For a focused check, use
  `.tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.config.mjs`
  with the required test filters.
- Keep the serial startup check in `validation/browser-startup.mjs`. Do not
  bypass it or retry a browser startup failure through more test workers.
- Trusted project rules load when Codex starts. Restart Codex after changes
  to `.codex/config.toml` or `.codex/rules/`. Active session overrides and
  managed restrictions can take precedence. See [validation guidance](docs/validation.md).
