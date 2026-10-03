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
recognition appears as a single “Artist — Song” line below the normal visualization.
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

## One real lookup, explicitly requested

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
For a reproducible candidate, [AudD's example-file recipe](https://audd.io/resources/recipes/podcast-music-credits)
identifies `https://audd.tech/example.mp3` as
**Tears For Fears — Everybody Wants To Rule The World**. The general API docs'
sample response naming “Warriors” is not this clip's identity.
Download and convert it locally first
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
  --artist 'Tears For Fears' --title 'Everybody Wants To Rule The World' \
  > .cache/recognition-live/result.json
```

The report records the endpoint, clip SHA-256, timestamps, HTTP status, expected
and actual match, and number of Worker requests. It does not store audio or a
token. One Worker request may be rejected before AudD; the report does not claim
provider billing attribution. A pass establishes real recognition for that
clip through the deployed service; microphone capture, browser display and
physical-iPhone recognition still need their own acceptance checks. Do not add
this command to routine CI or run it separately in each browser project.

On 2026-10-03 at 04:44:39 UTC, one live POST returned HTTP 200 and
**Tears For Fears — Everybody Wants To Rule The World** for the prepared
168830-byte WAV (SHA-256
`b4f23035fb8a70d3533fbe04a5533ac80d1f4cb5b51df490ffe56c6491205acb`).
The initial test failed because its expected song had been taken from the
unrelated “Warriors” sample response. The returned identity agrees with the
example-file recipe above; the documented expectation is now corrected.
No second live request was made, and the initial failed report is preserved in
[the live evidence](recognition-results/2026-10-03-live.json).
