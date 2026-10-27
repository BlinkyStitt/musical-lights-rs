# Continuous music tempo fixtures

“Carefree” and “Monkeys Spinning Monkeys” by Kevin MacLeod (incompetech.com),
licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
The recordings are provided without warranties under that license. These adapted
excerpts retain the original credit; no endorsement is implied.

Each file is the continuous 16–48 second interval, downmixed to mono, resampled
to 48 kHz and encoded as float32 little-endian. No gain normalization, repetition
or tempo adjustment was applied. They are test assets, not application assets.

[manifest.json](manifest.json) freezes source URLs, Commons description revisions,
published SHA-1 checks verified against downloaded bytes, SHA-256 digests,
decoder/version and exact commands. Source paths in those commands name the
local downloaded archives; substitute their locations when reproducing.
An uninterrupted full decode was compared byte for byte with each excerpt at
sample offsets 768000–2304000. Both decode with `-xerror` and contain only finite
samples. There is no seek, padding, loop or splice within either excerpt.

Independent labels come from the composer's [catalog data](https://incompetech.com/music/royalty-free/pieces.json),
keyed by ISRC: USUAN1400037 is **96 BPM**, USUAN1400011 is **144 BPM**.
The Carefree archive also embeds its ISRC and 96 BPM in its MP3 tags.
The [Monkeys description](https://commons.wikimedia.org/w/index.php?oldid=1261170356)
identifies that ISRC, 144 BPM, 2:05 duration and the YouTube-derived rendition.
The [Carefree description](https://commons.wikimedia.org/w/index.php?oldid=1086677344)
identifies the direct Incompetech import. These bind the recordings to the labels;
alternate versions listed elsewhere are not used. Source license notices offer
CC BY 3.0 (as well as later alternatives); this distribution uses CC BY 3.0.

The transition test has exactly one declared splice: Carefree's excerpt end
followed immediately by Monkeys' excerpt start, without resetting analysis.
Accuracy is required at every aligned half-second checkpoint from 24 through
32 seconds of each excerpt, including after that splice. Source labels and
excerpt selection were frozen before estimator experiments.


Before the repair, Linux x86_64 / nightly-2026-09-10 default-feature analysis
reported Carefree at 187.275–187.950 BPM during the acceptance window; Monkeys
reported 134.025 BPM at 24 seconds and reached ±5 BPM only after 26 seconds.
The default-feature pre-change SHA-256 measurements below matched after the
repair. Each digest concatenates the real frame sample index (u64 LE), all 240
specific loudness values (f64 LE), then all 24 targets and 24 filtered targets
(f32 LE), for all 16,000 emitted frames. These historical hashes are host/math
configuration specific; portable regressions compare the independent original
measurement path within each feature configuration.

| Clip | Pre/post raw-loudness and target SHA-256 |
| --- | --- |
| Carefree | `416b87f894173490f9287191410add9d5f5135456db412b004ecb3605dd1cbed` |
| Monkeys | `4b7addbcc4fc3c77405e60e3e5f5f6a2342237903d4ce155f20b6e797a8999db` |
