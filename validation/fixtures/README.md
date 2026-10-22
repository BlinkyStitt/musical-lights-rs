# Rotation playback fixture

`rotation-clock.mp4` is a generated moving test pattern, with no captured or
third-party media. It has no audio; the rotation test separately drives the real
AudioWorklet with a synthetic microphone tone. The 90-second duration exceeds
the test's 60-second deadline so every rotation can assert an advancing playhead
and newly presented frames without seeking or looping. It is continuity
evidence, not a video quality or physical-device performance benchmark.

Generated with FFmpeg 8.0.1 and libx264 from the repository root:

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=160x90:rate=10 \
  -t 90 -an -c:v libx264 -profile:v baseline -level 3.0 -preset veryslow \
  -crf 35 -g 20 -pix_fmt yuv420p -threads 1 -movflags +faststart \
  validation/fixtures/rotation-clock.mp4
```

The fixture is checked in; validation needs no encoder or network media source.
