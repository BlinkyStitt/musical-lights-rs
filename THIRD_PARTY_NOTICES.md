# Loudness model

The ISO 532-1 numerical tables and temporal equations in
`musical-lights-core/src/audio/loudness` were transcribed and adapted from
MoSQITo 1.2.1 under Apache-2.0. Its upstream documentation carries the notice
"Copyright 2024, Green Forge Coop".
The Rust implementation uses continuous scalar state instead of offline NumPy
arrays. See <https://github.com/Eomys/MoSQITo/tree/v1.2.1>.

The Apache-2.0 license is reproduced in `licenses/Apache-2.0-MoSQITo.txt`.

ISO's reference archive remains an unchanged external validation input. The
repository does not redistribute the ISO programs, recordings, or worksheets.

# Rigid-body visualizer

Rapier 3D 0.34.0, by Sébastien Crozet and Dimforge, uses Apache-2.0.
Its upstream license is in `licenses/Apache-2.0-Rapier.txt` and the browser
distribution at `physics/RAPIER-LICENSE.txt`. See <https://github.com/dimforge/rapier>.

Three.js 0.186.0 uses the MIT license. The browser distribution includes its
upstream notice and license at `physics/THREE-LICENSE.txt`.
The build resolves the official RoundedBoxGeometry module's import to the
bundled Three.js copy. See <https://github.com/mrdoob/three.js>.

# Catalog starfield

The starfield uses a subset of David Nash / Astronexus's HYG Database 4.1,
revision `c7f7f883fe678cc7680169a50ccd7dcc49b060ce`, under CC BY-SA 4.0:
https://github.com/astronexus/HYG-Database/tree/c7f7f883fe678cc7680169a50ccd7dcc49b060ce/hyg.
The derived data in `musical-leptos/src/physics/stars-catalog.js` has the same
license. It excludes the Sun, selects stars with apparent V magnitude <= 6.5,
and retains IDs, J2000 coordinates, magnitudes and B-V indices.
`validation/generate-stars.py` reproduces it from the hash-checked source CSV.
The full license is in `licenses/CC-BY-SA-4.0-HYG.txt` and the browser bundle's
`physics/HYG-LICENSE.txt`. Projection, display brightness compression, color
tints and musical twinkle are application rendering choices. The sky is a
fixed celestial view around Orion, not a live local-horizon calculation.

# Historical partial-loudness validation

Earlier browser builds used Dominic Ward's loudness under GPL-3.0-or-later.
The current processor no longer includes that implementation. Historical audit
scripts and results remain in `validation/partial` and `docs`; their upstream
reference is https://github.com/deeuu/loudness/tree/82de790f79c5b358040861e8bdb906a55009b117.
The historical license remains in `licenses/GPL-3.0-loudness.txt`.

# Shared presentation algorithms

The shared visual filter implements Casiez, Roussel, and Vogel, "1 Euro Filter",
CHI 2012, DOI 10.1145/2207676.2208639: https://gery.casiez.net/1euro/.
The shared-band coefficient is an application adaptation.

Canonical log-loudness onset features follow principles discussed by Bello et al.,
"A Tutorial on Audio Transient Detection", 2005, DOI 10.1109/TSA.2005.851998.
Thresholds, bounded candidates, acoustic prominence, rearming, and white pulses
are application-specific engineering choices. No upstream detector source is bundled.

The causal autocorrelation tempo estimator adapts principles from Ellis,
"Beat Tracking by Dynamic Programming", 2007, DOI 10.1080/09298210701653344.
It does not implement the complete dynamic-programming beat path.
See `docs/loudness.md` for research links and each source's role.

Runtime listening review excerpts (CC BY 3.0): “Jazz Trumpet Loops Pack in F
90 bpm” by [Mihai Sorohan](https://freesound.org/s/77711/) and “Vibe Ace” by
[Kevin MacLeod](https://freemusicarchive.org/music/Kevin_MacLeod/Jazz_Sampler/Vibe_Ace).
Obtained from [librosa/data revision 38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0](https://github.com/librosa/data/tree/38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0/audio),
decoded to mono 48 kHz float32 and scaled once to peak 0.2 for the original audit.
Trumpet uses the available first 5.333 seconds; Vibe Ace uses seconds 8–14.
The versioned assets reuse those exact audit PCM bytes. Source and PCM hashes
are in `musical-leptos/public/review/clips.json`. License:
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).

Test-only tempo excerpts: “Carefree” (USUAN1400037) and “Monkeys Spinning
Monkeys” (USUAN1400011), Kevin MacLeod (incompetech.com),
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Continuous seconds
16–48 were downmixed to mono 48 kHz float32, without gain or tempo changes.
The Monkeys archive was previously transcoded from YouTube. Source notices,
independent tempo labels, revisions, verified hashes and decoder commands are in
[musical-lights-core/tests/fixtures/tempo](musical-lights-core/tests/fixtures/tempo/README.md).

# Navigation and radio

The firmware uses lora-phy 3.0.1 (MIT OR Apache-2.0), nmea 0.8.0 (Apache-2.0),
hmac 0.13.0 and sha2 0.11.0 (MIT OR Apache-2.0), and world_magnetic_model
1.2025.0 (MIT OR Apache-2.0). Their published crates retain their upstream notices.
See [dependency review](docs/dependencies.md).

The WMM2025 regression fixture comes from NOAA/NCEI's official
[WMM2025 coefficient and test archive](https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip).
It contains U.S. Government reference data. The test compares all 100 supplied
reference points. This verifies calculations, not the installed compass accuracy.

The Fibonacci256 coordinate table retains its original Jason Coon LED Mapper
source link in `musical-lights-core/src/lights/fibonacci_layout.rs`.
