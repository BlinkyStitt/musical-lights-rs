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
