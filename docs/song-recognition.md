# Manual song recognition

Turn on **Listening**, then press **Identify song**. Each press records the next ten
seconds using the existing microphone stream and sends it through the Rust
Cloudflare Worker to AudD. There is no periodic recognition or automatic retry.
Listening and loudness analysis otherwise stay on the device.

After an upload starts, **Identify song** waits one minute before allowing
another recording. The countdown applies to successes, no matches, failed
uploads and uploads canceled after submission. It survives navigation, reloads
and other tabs when browser storage is available. Canceling before submission
uses no lookup and starts no cooldown. This reduces repeat lookups; it does not
reuse an old match for music that may have changed.

Cancel, Stop listening, hiding the page, and leaving Home cancel pending capture
or upload. Canceling after the Worker has contacted AudD cannot undo that lookup
or its cost. No audio is persisted by our application or Worker; AudD receives
the recording and its own service terms apply.

Successful detections show artist and title above the lights (also in fullscreen).
Long titles scroll unless Reduced Motion is enabled. Each successful press saves
a separate localStorage entry, including repeat songs, with sample start/end and
recognition timestamps in UTC. These are detection times, not song start times.
The history view shows the latest 50; CSV and JSON exports include all entries.
Storage failures leave entries available for export for the current page session.
Browser storage can be cleared or evicted; Safari and installed web apps may have
separate storage. Export history you want to keep.

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

### One real lookup, explicitly requested

Routine validation and CI use fakes and make no paid lookups. To confirm the
deployed Worker, its server-side token, and actual AudD matching, run the separate
smoke test **only when quota is available**. It requires `--live`, sends at most
one POST, and never retries or follows redirects. No token is needed locally.
A no-match, wrong song, provider failure or timeout fails the test. Exit codes
are 0 for an exact artist/title match, 1 for a failed lookup, and 2 for invalid
arguments or a clip rejected before upload.

Use a known short WAV, M4A, WebM or Ogg excerpt under 512 KiB, with the
expected catalog artist and title. The licensed listening-review clips have
not been confirmed in AudD's catalog; they are not recognition ground truth.
For a reproducible candidate, [AudD's official example](https://docs.audd.io/)
provides `https://audd.tech/example.mp3` with the documented result
**Imagine Dragons — Warriors**. Download and convert it locally first
(requires FFmpeg); these preparation steps make no recognition requests. The
current example is about five seconds long; longer inputs are trimmed to ten:

```sh
mkdir -p .cache/recognition-live
curl --fail --location https://audd.tech/example.mp3 -o .cache/recognition-live/example.mp3
ffmpeg -y -i .cache/recognition-live/example.mp3 -t 10 -ac 1 -ar 16000 .cache/recognition-live/example.wav
```

Once quota is available, from the repository root:

```sh
export PATH="$PWD/.tools/bin:$PATH"
node validation/recognition-live.mjs --live \
  --file .cache/recognition-live/example.wav \
  --artist 'Imagine Dragons' --title 'Warriors' \
  > .cache/recognition-live/result.json
```

The report records the endpoint, clip SHA-256, timestamps, HTTP status, expected
and actual match, and number of Worker requests. It does not store audio or a
token. One Worker request may be rejected before AudD; the report does not claim
provider billing attribution. A pass establishes real recognition for that
clip through the deployed service; microphone capture, browser display and
physical-iPhone recognition still need their own acceptance checks. Do not add
this command to routine CI or run it separately in each browser project.
