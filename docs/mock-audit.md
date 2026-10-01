# Mock audit — 2026-10-01

Audited the validation test doubles and browser instrumentation, including the
permission work in PR #28, shared audio/motion fixtures, worklet harness, screen
controls, deployment fixtures, timing/review scripts, and Python tooling tests.
The corrections below change tests and their claims, not web-app behavior.

## Findings corrected

| Finding | Correction |
| --- | --- |
| Setting `navigator.standalone` did not exercise any app code, yet the test name claimed Home Screen coverage. | Removed the flag and claim. Test root and phone URLs with query/hash directly, including reload. Installed apps remain untested. |
| Permission queries accepted any descriptor and returned mutable statuses; the Node test shared one object across microphone and both sensors. | Reject unknown descriptors, return separate statuses with read-only state/name, keep per-descriptor backing state, and assert microphone revocation leaves sensors unchanged. |
| Closing during permission queries settled only the last of three requests. | Settle all three and assert none installs an observer or publishes after close. |
| Sensor permission stubs granted outside a gesture. | The shared browser fixture checks native transient activation. These fixtures model an initial prompt, not Safari's cached-grant rules. |
| Assigning `getUserMedia` on a native wrapper can be lost when WebKit recreates that wrapper. | Put replacements on `MediaDevices.prototype`; delegating observers preserve the original receiver and arguments. |
| Two calibration init scripts depended on their evaluation order, which Playwright does not guarantee. | Compose the pending-capture and worklet instrumentation in one init script. |
| A late-capture cleanup test closed its source before asserting the track ended. | Keep the source context alive until the app has stopped the track, then close it. |
| The worklet MessagePort mock retained message objects and did not detach transferred buffers. | Use `structuredClone` with the transfer list and assert detachment. A bad transfer or reuse now fails instead of silently passing. |
| Overriding `isSecureContext` tested only UI branching. | Replace it with a real non-localhost HTTP origin and assert the browser actually hides `mediaDevices`. |

## Browser-native checks

`permissions-native.spec.mjs` runs in the installed full Chromium engine with a
virtual microphone and virtual sensor readings. It uses the real Permissions
API, capture implementation, tracks, AudioWorklet and trusted motion events.
The capture observer delegates to the native method without changing results.
There is no fake permission UI flag or JavaScript replacement for permission
queries or sensor events.

- Browser-controlled microphone grants are displayed before capture; opening
  and reloading the page makes zero capture requests.
- Native capture produces live tracks; Stop and route exit end those tracks.
- Browser-controlled denial rejects capture; permission changes update the
  mounted status, including reset to prompt.
- A genuinely insecure origin shows the HTTPS guidance.
- Browser-delivered `isTrusted` acceleration events reach the real motion
  listener and produce vertical force; disabling motion clears all force axes.

Playwright sets permission overrides in a browser context. Their survival across
reload **does not prove persistent user consent across browser restarts**.
Virtual devices do not exercise OS microphone consent, phone hardware, or Safari
Home Screen storage. Full Chromium is required here: the headless shell's media
request delegate reported “Not supported” even when query state was granted.
The serial startup guard still checks this project before test workers start.

## Retained fixture boundaries

| Fixture family | What it establishes | What it cannot establish |
| --- | --- | --- |
| `permissions.spec.mjs`, permission/motion Node harnesses | UI states, unsupported APIs, stale promises, observer cleanup, input math | Browser-specific descriptor support, real prompts, remembered user consent, sensor gating |
| `physics-state.mjs`; balloons, edges, spectrum and layout tests | Real rendering/physics reactions to selected packets; session handling and bounded queues | Microphone authorization, physical sensor scale, end-to-end acoustic latency; injected packets bypass real port transport |
| Browser/calibration/tones/screen synthetic capture | Real AudioContext, oscillator, MediaStream and DSP paths; fault handling | OS input settings or physical calibration. Calibration `getSettings` is deliberately controlled to test invalidation |
| Worklet VM and direct WASM fixtures | Production DSP, packet contents, transfer detachment, partition invariance, explicit ACK behavior | Real audio-thread scheduling or MessagePort task ordering; the browser audio tests supply that integration coverage |
| Screen EventTarget/sentinel doubles; forced missing/rejected APIs | Fullscreen/wake-lock state transitions and cleanup, including late completion | OS power policy or mobile browser chrome. Separate browser tests exercise native fullscreen and wake-lock APIs |
| Deployment HTTP fixture and aborted asset routes | Real built modules/workers/worklets, missing-asset recovery, version checks | CDN caching or schema compatibility between independently compiled releases; fixture versions reuse one build |
| `listening-review.spec.mjs`, playback-clock harness | Clock arithmetic, fallback labels, review UI/export | Audible playback or listening judgment; the AudioContext is entirely simulated |
| Static preview / flash demo / timing scripts | Built code under controlled local assets or recorded DSP packets; explicit host timings | Production networking, TLS, CSP, microphone latency, physical-phone performance. Blob worklet loading bypasses the deployed fetch path |
| Installer/publisher Python fixtures | Retry bounds, atomic files, content hashing and route rewriting | Network interoperability or validity of placeholder WASM files; deployment/browser tests exercise executable assets |
| Browser startup failure harness | Fail-fast handling and crash bounds using an intentionally failing executable | Successful browser operation; the real serial startup guard supplies that check |

Synthetic buffers, changed `currentTime`, manual events, unavailable APIs, and
fault injection remain intentional in narrowly scoped tests. They must not be
reported as physical-device, OS-permission, or production-network acceptance.

## Separate unresolved repository finding

`musical-adafruit-sparkle-idf/src/main.rs` calls `mock_loop` after its UART reader
returns, without a debug-only guard. `sensor_uart.rs` then fabricates `Pong` and
`Orientation::Unknown`. This can conceal a sensor-board failure in that embedded
target. It is pre-existing, outside the web-app deployment, and is not repaired
or hardware-validated by this permission/test change.

## Validation result

The pinned `python3 validation/validate.py browser` run passed all 22 Node harness
tests and all 263 Playwright checks, including the four native Chromium cases,
WebKit, and the iPhone WebKit profile. It used macOS host access, the serial
startup guard, one worker, and zero retries. All six Python tooling tests also
passed. No web-app production changes were needed to pass these stricter checks.
Firefox and physical iPhone/Home Screen behavior remain unverified locally.

## References

- [Playwright init-script ordering and permission overrides](https://playwright.dev/docs/api/class-browsercontext)
- [Media capture permissions integration](https://w3c.github.io/mediacapture-main/#permissions-integration)
- [Motion permission request algorithm](https://w3c.github.io/deviceorientation/#dom-devicemotionevent-requestpermission)
- [Chromium sensor emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setSensorOverrideEnabled)
