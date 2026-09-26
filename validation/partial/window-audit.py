"""Quantify the fixed FFT choice against a six-window front end; no fitting.

This is not full GM2002 conformance. Both paths use the same pinned upstream
partial-loudness stages, retaining the app's 25 source-band decomposition.
"""

import hashlib
import json
from pathlib import Path

import numpy as np
from validate import REVISION, STRIDE, binary, build_oracle, spectral_frames, tone


def multires(pcm):
    edges = [10, 80, 500, 1250, 2540, 4050, 15001]
    windows = [3072, 1536, 768, 384, 192, 96]
    padded = np.pad(pcm.astype(np.float64), (3072, 0))
    frames = np.lib.stride_tricks.sliding_window_view(padded, 3072)[48::48]
    frequencies, powers = [], []
    for i, size in enumerate(windows):
        lo, hi = np.ceil(np.array(edges[i : i + 2]) * 4096 / 48000).astype(int)
        window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(size) / size)
        offset = (3072 - size) // 2
        fft = np.fft.rfft(frames[:, offset : offset + size] * window, n=4096)
        power = np.abs(fft[:, lo:hi]) ** 2
        # Upstream Window ENERGY and PowerSpectrum AVERAGE_POWER normalization.
        powers.append(power * (2 * (2 / 2e-5) ** 2 / (4096 * np.sum(window**2))))
        frequencies.extend(np.arange(lo, hi) * 48000 / 4096)
    header = np.array([len(frequencies), 1000, *frequencies], dtype="<f8")
    spectrum = np.concatenate(powers, axis=1).astype("<f8")
    return binary(
        [".cache/partial-oracle-run", "--grid"],
        header.tobytes() + spectrum.tobytes(),
        len(frequencies) + 25 * 149 + 24 * 149 + 48,
    )[:, -24:]


def main():
    build_oracle()
    cases = []
    for frequency in [50, 150, 250, 1000, 3400, 8600, 13700]:
        pcm = np.concatenate(
            [np.zeros(19200), tone(frequency, 0.8), np.zeros(19200)]
        ).astype("<f4")
        fixed = binary(
            [".cache/partial-oracle-run"],
            spectral_frames(pcm).astype("<f8").tobytes(),
            STRIDE,
        )[:, -24:]
        reference = multires(pcm)
        case = {"frequencyHz": frequency, "pcmSha256": hashlib.sha256(pcm).hexdigest()}
        for label, values, hop in [
            ("fixed", fixed, 0.002),
            ("sixWindow", reference, 0.001),
        ]:
            band = int(np.argmax(values.mean(axis=0)))
            curve = values[:, band]
            time = (np.arange(len(curve)) + 1) * hop
            steady = float(curve[(time >= 1) & (time < 1.2)].mean())
            rise = float(time[np.flatnonzero(curve >= steady * 0.9)[0]] - 0.4)
            fall = float(
                time[np.flatnonzero((time > 1.2) & (curve <= steady * 0.1))[0]] - 1.2
            )
            case[label] = {
                "dominantBand": band,
                "steadySones": steady,
                "rise90Ms": rise * 1000,
                "fall10Ms": fall * 1000,
            }
        # Compare actual end-sample times. Do not fit a gain or temporal offset.
        case["maxBandDifferenceSones"] = float(np.abs(fixed - reference[1::2]).max())
        cases.append(case)
    output = Path("docs/audio-audit-results")
    output.mkdir(exist_ok=True)
    (output / "windows.json").write_text(
        json.dumps(
            {
                "upstreamRevision": REVISION,
                "numpyVersion": np.__version__,
                "sourceSha256": {
                    file: hashlib.sha256(Path(file).read_bytes()).hexdigest()
                    for file in [
                        "validation/partial/window-audit.py",
                        "validation/partial/oracle.cpp",
                    ]
                },
                "status": "quantified model difference, not a conformance pass",
                "fixed": {
                    "windowMs": 2048 / 48,
                    "hopMs": 2,
                    "centerBeforeEndMs": 2048 / 96,
                },
                "reference": {
                    "windowMs": [64, 32, 16, 8, 4, 2],
                    "hopMs": 1,
                    "fftSize": 4096,
                    "centerBeforeEndMs": 32,
                    "frequencyLimitHz": 15001,
                },
                "fittedGain": False,
                "fittedTimeShift": False,
                "cases": cases,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
