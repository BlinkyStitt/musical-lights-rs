# Opt-in song recognition

Turn on **Listening**, then enable **Identify song**. While enabled, it records
ten seconds from the existing microphone and sends the sample through the Rust
Cloudflare Worker to AudD at most once per minute. Provider or recording errors
turn the switch off; no automatic retry follows an error. No-match lookups keep
the previous song and continue the opted-in schedule. Digital playback never
uses recognition or requests the microphone.

The SVG ring beside the switch shows waiting, capture and upload phases, with
an accessible phase description. It updates discretely once per second, has no
spinning animation, and does not announce a live countdown. Reduced Motion also
stops title scrolling and wraps the complete artist and song name. Successful
recognition appears as a single “Artist — Song” line above the normal visualization.
In fullscreen, the same line travels continuously right to left at 45 pixels per
second, even for short names, like the hat's text display. There are no recognition
captions, duplicate success blocks, or exit-hint banner. Errors and no-match
notices stay beside Identify song; microphone recovery stays above the footer.

Switching identification off, stopping the microphone, changing source, hiding
the page, or leaving the route cancels pending capture/upload. Canceled captures
spend no lookup. Canceling an upload cannot undo a request already sent to AudD.
The minute cooldown starts immediately before submission, including failures;
it survives reloads/tabs through shared storage. Web Locks serialize reservation
across supported tabs. If storage or Web Locks are unavailable, only session
throttling and the server's request limit can be guaranteed.

Recognition is off by default. The history disclosure states that recordings
leave the device. Our app and Worker do not persist audio. Each success saves
separate local metadata with sample start/end and recognition timestamps in UTC;
these are detection times, not song start times. History shows the latest 50,
while CSV/JSON exports include all entries. Storage failure retains metadata in
memory for export. Safari and installed web apps may have separate storage.

## Deployment and credentials

The Worker is deployed at
`https://musical-lights-recognition.satoshiandkin.workers.dev/recognize`.
The website endpoint is configured in the `musical-lights-recognition` meta tag
in `musical-leptos/index.html`; an empty value disables recognition.
Only the production website can use a cross-origin recognition endpoint.
Local development and preview builds ignore the inherited production endpoint;
use a same-origin `/recognize` mock to develop the feature without paid calls.

Create an AudD token at <https://dashboard.audd.io/>. From the repository root:

```sh
export PATH="$PWD/.tools/bin:$PATH"
npm ci --prefix musical-recognition-worker
musical-recognition-worker/node_modules/.bin/wrangler login
musical-recognition-worker/node_modules/.bin/wrangler secret put AUDD_API_TOKEN --config musical-recognition-worker/wrangler.toml
```

Enter the token at Wrangler's secret prompt. Never put it in browser code, chat,
Git, or a public build variable. Until configured, recognition returns HTTP 503.
The Worker accepts only the configured website Origin, supported audio types,
and recordings up to 512 KiB. It sends one request to the fixed AudD endpoint and
times out after 20 seconds. Provider error details are never returned to clients.

Rate limits allow one request per IP and twenty total per minute **per
Cloudflare location**. Origin checks are browser isolation, not authentication;
non-browser clients can forge Origin. These limits are not a global spending
cap. Configure an appropriate AudD allowance and monitor provider usage before
adding a paid token to this public service.

To build and deploy subsequent changes from the repository root:

```sh
cargo install worker-build --version 0.8.7 --locked --root .tools/worker
npm --prefix musical-recognition-worker run deploy
```

Worker tooling is separate from the website's pinned wasm-bindgen toolchain.
Use the package script so the custom build runs in the Worker directory. Worker
CI validates and packages without credentials; it does not automatically deploy.

## Validation

```sh
cargo fmt --manifest-path musical-recognition-worker/Cargo.toml --check
cargo test --locked --manifest-path musical-recognition-worker/Cargo.toml
cargo clippy --locked --manifest-path musical-recognition-worker/Cargo.toml --target wasm32-unknown-unknown -- -D warnings
npm --prefix musical-recognition-worker run deploy -- --dry-run
npm --prefix musical-recognition-worker test
node --test validation/harness/recognition.test.mjs
python3 validation/validate.py leptos
python3 validation/validate.py browser
```

Use the pinned tools and macOS host access described in [validation.md](validation.md).
Worker integration tests execute the compiled WASM with fake AudD responses.
Chromium/WebKit tests exercise real audio encoding plus controlled recognition
responses, cancellation, history, exports, fullscreen and Reduced Motion.
The pinned Linux WebKit build omits MediaRecorder, so it verifies the unavailable
state and uses the controlled recorder for UI tests. Native encoding is checked
in Chromium and macOS WebKit. These checks do not establish real AudD recognition
quality or physical iPhone behavior.

The fullscreen ticker follow-up passes 51 focused Chromium, macOS WebKit and
iPhone-profile WebKit checks, 14 offline recognition checks, and the Leptos
build/test/Clippy checks. Ticker checks cover short and long names, constant
leftward travel, looping, light/dark themes, rotation and Reduced Motion.
Recognition responses are mocked; physical-phone acceptance remains pending.
The follow-up also waits for simulated scrolling to settle before checking its
stopped position, and keeps the injected expensive-tick fixture running until
snapshots are actually published. Single-tick yield, zero discarded time, debt
and fullscreen snapshot-age limits remain enforced.

## Separate live check

Routine browser/harness tests use a mock recognition endpoint. The standalone
`validation/live-recognition.mjs` sends exactly one request when explicitly
invoked with `RUN_LIVE_RECOGNITION=1`, a known public/licensed ten-second WAV,
and the deployed HTTPS recognition endpoint. It is excluded from routine suites
and has no retries. Record its result separately from local mocks and encoding.
