# Web presentation contract

- Keep common controls grouped, Listening beside Identify song, visible focus,
  native switches and 44-pixel touch targets. Use hover/focus help and a mobile
  tap popup. Keep less common settings collapsed below the scene on normal pages.
  In fullscreen, place the shared controls in a Settings modal over the top
  half of the scene. Keep the lower half visible through a clear backdrop.
  Keep the main view fixed. Scroll settings inside the modal body; keep its
  Close button fixed and trap focus.
  Escape closes Settings before it exits fullscreen. Keep Listening to the left
  of the gear button in the top toolbar when Settings is closed. Reuse the
  same Listening control inside the modal when Settings is open.
- Mobile opens in the expanded video/visualizer layout with Settings and Exit
  controls, without starting audio or requesting native fullscreen. Normal pages use the same
  video/scene/bottom-controls order, with extra settings and learning below.
  Keep Exit usable in short
  landscape screens, with safe areas, recognition and recovery notices.
  Float the video entry over the scene. Keep scene and collider size stable
  while the on-screen keyboard opens; fit the entry to the visible viewport.
  Restore layout sizing and dismiss the keyboard on Load, Remove and Exit.
- Matching bars grow inward from both ends and reserve space for the balls.
  Omit Quiet/Loud labels. Keep a single accessible meter per source band
  despite background banks and depth drawing.
- Draw a direction probability only after a new attack exceeds the recent
  loudness peak. Defaults rise from 5% at 60 BPM to 50% at 200 BPM. Advanced
  settings expose the endpoint tempos, probabilities and curve. Preserve
  seeded replay and reject invalid settings; do not reverse on a fixed timer.
- Depth controls the physical enclosure in centimeters, from 20 to 200 with a
  48 cm default. Apply it live without resetting the balls or their colors.
  Keep 0–16 opaque physical balls (two by default) and eight full-size background boxes beside
  the center box. Reuse all source bands in matching vertical banks. Extend
  source posts through the actual collider depth. Cull side posts against
  their complete bounds and verify visible pixels before claiming savings.
  Use one transparent outer coating with no internal partitions. Keep drawing
  bounded; avoid recursive cameras, shadow maps and bloom.
- Start each ball in the color of the source band at its spawn X. Physical
  contacts pick up source colors with or without audio. Fill the rolling surface
  gradually with core-owned, elapsed-time calculations. Do not add autonomous
  hue cycling. Reduced Motion stops scrolling, camera motion and extra pigment
  drift. Keep all bands responsive with the configured rise duration; measure
  packet-to-render delay as well as steps. Hide BPM when audio stops; silence
  eases to the shared core's 60 BPM fallback without changing loudness or targets.
- Show one scrolling artist/song title in expanded mode. Keep the progress
  ring and errors beside Identify song. Show small rendered FPS beside the angle
  slider in normal Home and expanded mode. Camera motion uses a smooth horizontal
  sweep without attack shake or vertical wobble. Do not draw box-frame outlines
  or black bar borders. Retain white attack edges. Repeat source lighting across
  the nine banks, with one outer coating and no internal walls.
  Normal-page scenes use equal gutters and a responsive 320–560 pixel height.
  The default sweep spans −10° to +10° over a 48-second cycle.
- Listening adds a core-owned travelling floor of at most one sixth of bar
  travel. Keep measured loudness, filtered targets, accessible audio meters and
  attack eligibility separate. Disable this floor under Reduced Motion and
  when the microphone session stops or is interrupted. Record the combined
  visual inputs so physics replay reproduces the wave.
- Prefill the YouTube field with the default video. Load only on an explicit
  Load video action. Clearing the field preserves the playing video and saves
  the empty preference; Remove video stops the player.
