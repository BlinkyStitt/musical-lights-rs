# YouTube, fullscreen controls, and musical dance

Paste a YouTube video link through **Video**, then choose **Load video**. Loading
does not start playback or request the microphone. The embedded player keeps
YouTube's controls and inline playback. The app supports watch, short, live,
embed, and youtu.be links with optional start times. It does not search YouTube.
Invalid replacement links retain the current player. Removal and route exit
destroy it. Starting a digital audio source pauses the video; starting video
stops a competing digital source without starting Listening.

**Listening** uses the microphone. YouTube does not expose decoded PCM to this
app, so microphone-driven lights must hear the video through the speakers.
Recognition remains a separate opt-in microphone upload with the existing
ten-second capture, shared minute cooldown, and development upload restriction.
Playing a video alone uses the idle animation, not measured YouTube loudness.
Where available, the Audio Session API selects `play-and-record` during capture
and `playback` for video alone, then restores the previous type on route exit.
This API selection does not prove that an actual iPhone routes both streams.

Fullscreen portrait reserves separate video, visualizer, song ticker, recovery,
and bottom control regions. Landscape places video and visualizer side by side.
Balls and bars stay inside the scene, outside the controls. The player has a
minimum 200 × 200 pixel region. Listening and Identify song occupy the first
two grid cells. Native switches keep 44-pixel touch targets and keyboard focus.
Tap, hover, or focus a label to read help without changing its switch; Escape
closes the box. Microphone state and routine recognition availability appear
in this help. Actionable failures remain in visible recovery notices.

The single artist/song ticker retains its continuous leftward travel and
Reduced Motion wrapping. There is no recognition caption or exit-hint banner.
The camera slider stays below the normal scene on both Home and Advanced. It
shows rendered yaw, including the gentle ±4° sway and bounded attack kick.
Dragging temporarily stops automatic motion. Reduced Motion disables sway,
kicks, scrolling, direction draws, and extra pigment drift.

## Embedded contract

`musical-lights-core::lights::dance` owns the allocation-free, `no_std` policy.
Neither the browser nor Rapier decides whether an acoustic crest qualifies.

- `RecentPeak` consumes genuine attacks and unscaled loudness. An eight-second
  decaying recent maximum gates decisions. A 60 ms crest group joins attacks
  across frequency bands into one decision.
- `DanceMotion` consumes one seeded draw per accepted crest. At the default
  10% total chance, the outcomes are 90% unchanged, 5% horizontal reversal,
  and 5% floor/ceiling change. Changing the total chance preserves equal axis
  shares. Time alone never reverses measured-audio direction.
- Travel follows smoothed tempo at two columns per beat: four columns per
  second at 120 BPM. Changes retain continuous position and ease velocity.
- `IdlePeak` keeps separate synthetic history. Idle motion can draw only after
  a completed travelling-wave cycle and a qualifying synthetic crest.
- `flight_height` and `release_speed` calculate the shared flight budget and
  `sqrt(2gh)` speed limit. Normal flight reserves 30% of available enclosure
  space after ball clearance; the slider allows 0–50%. Reduced Motion halves
  the budget and caps it at 2.5 cm.

The browser stores display preferences and applied physics settings locally.
It restores no microphone permission, live listening, sensor session, or opted-in
recognition. Storage failure retains usable session settings. Display reset
restores defaults; Input and Physics keep their separate reset scopes.

The worklet adds cue ordinals to existing tempo metadata. Raw loudness,
filtered-target transport, acoustic traces, and the 38-value physics input
layout remain unchanged. Physics protocol 8 and phone report v3 record the
random seed, dance settings, starting ordinal, and applied motion/tempo events
for exact replay with the matching WASM engine. Buffers allocate only when
recording starts. No alternate timed-reversal engine remains.

Floor/ceiling transitions retract the bars before switching collider positions,
then regrow them over 500 ms. Gravity stays measured/default gravity. Ceiling
bars can leave balls resting on the floor. Beach-ball density, restitution,
friction, angular damping, quadratic drag, containment, and contact pigments
retain the existing prototype assumptions. This is a visual model, not a
measured concert-ball material model.

## Verification and release boundary

Routine browser tests mock YouTube and recognition. They check ownership,
cleanup, layout, saved settings, help interaction, and Audio Session API choices;
they cannot prove speaker routing or physical iPhone capture. The optional live
YouTube test uses Google's public iframe-demo video and no recognition upload.

Run checks from the repository root with pinned tools. Use macOS host access for
browser commands. Keep the serial startup guard, one worker, and zero retries.

The final full browser run passes 382 checks with zero failures and two opt-in
skips. Core passes 67 tests in each of four feature configurations; physics
passes 42 tests and the offline harness passes 73. Worklet, Leptos, and reference
checks pass. The core also compiles for both `thumbv6m-none-eabi` and
`thumbv7em-none-eabihf` without `std`. All 38 complete acoustic traces match
the deployed PR #39 WASM bit for bit. Historical fixed-window numeric results
remain unchanged. See [the evidence record](youtube-dance-results/validation.json)
for build identities and test boundaries.

The [portrait](youtube-dance-results/mock-youtube-portrait.png) and
[landscape](youtube-dance-results/mock-youtube-landscape.png) layout images use a
mock player. The [live YouTube image](youtube-dance-results/live-youtube-chromium.png)
comes from the separately invoked real player test. The existing
[scrolling](musical-motion-results/scrolling-with-audio.mp4) and
[stationary](musical-motion-results/stationary-with-audio.mp4) previews use
identical licensed audio packets. Their approximate synchronization does not
measure output-device latency. The short host render measurements reach about
60 FPS; they do not satisfy physical-phone FPS acceptance or measure GPU completion.

```sh
export PATH="$PWD/.tools/bin:$PATH"
python3 validation/validate.py core worklet physics leptos reference
node --test validation/harness/*.test.mjs
python3 validation/validate.py browser
ML_LIVE_YOUTUBE=1 node validation/node_modules/@playwright/test/cli.js test youtube-live.spec.mjs --config=validation/playwright.config.mjs --project=chromium
node validation/musical-previews.mjs
```

Release remains held pending a physical iPhone test with audible YouTube and
simultaneous real microphone-driven lights. Test normal, portrait fullscreen,
landscape fullscreen, rotation lock, Reduced Motion, tilt, shake, and independent
Listening shutdown. Record the device, iOS version, browser, audible output,
capture state, and observed musical response. Desktop WebKit and its iPhone
profile do not establish this result. Human listening and five-minute phone
FPS acceptance remain separate from digital-music preview measurements.
