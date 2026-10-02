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

# Source-band partial loudness

`musical-lights-core/src/audio/partial` adapts the MGB1997 equations, numerical
coefficients, ear-response interpolation data, and roex lookup convention from
Dominic Ward's loudness, copyright 2014 Dominic Ward, under GPL-3.0-or-later:
https://github.com/deeuu/loudness/tree/82de790f79c5b358040861e8bdb906a55009b117.
The applicable license is reproduced in `licenses/GPL-3.0-loudness.txt`.
Browser builds containing this model must retain this notice, the GPL license,
and access to corresponding source. The unchanged upstream implementation is
fetched separately for the offline validation harness in `validation/partial`.
The existing ISO model's separate Apache-2.0 notice above still applies.

# Browser presentation algorithms

The browser-only motion filter implements the equations of Casiez, Roussel,
and Vogel, "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in
Interactive Systems", CHI 2012, DOI 10.1145/2207676.2208639. Its shared-band
coefficient is an application adaptation. Reference: https://gery.casiez.net/1euro/.

The spectral novelty calculation implements Böck and Widmer, "Maximum Filter
Vibrato Suppression for Onset Detection", DAFx 2013:
https://phenicx.upf.edu/system/files/publications/Boeck_DAFx-13.pdf.
Source-band attribution, loudness eligibility, bounded pending candidates,
rearming, and white pulses are application-specific presentation choices.
No upstream implementation source is bundled for these two algorithms.

Runtime listening review excerpts (CC BY 3.0): “Jazz Trumpet Loops Pack in F
90 bpm” by [Mihai Sorohan](https://freesound.org/s/77711/) and “Vibe Ace” by
[Kevin MacLeod](https://freemusicarchive.org/music/Kevin_MacLeod/Jazz_Sampler/Vibe_Ace).
Obtained from [librosa/data revision 38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0](https://github.com/librosa/data/tree/38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0/audio),
decoded to mono 48 kHz float32 and scaled once to peak 0.2 for the original audit.
Trumpet uses the available first 5.333 seconds; Vibe Ace uses seconds 8–14.
The versioned assets reuse those exact audit PCM bytes. Source and PCM hashes
are in `musical-leptos/public/review/clips.json`. License:
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
