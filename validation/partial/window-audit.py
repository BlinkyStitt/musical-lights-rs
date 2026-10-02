"""Quantify the fixed FFT choice against a six-window front end; no fitting.

This is not full GM2002 conformance. Both paths use the same pinned upstream
partial-loudness stages, retaining the app's 25 source-band decomposition.
"""

import hashlib
import json
from pathlib import Path

import numpy as np
from validate import (
    REVISION,
    STRIDE,
    binary,
    build_oracle,
    spectral_frames,
    tone,
)


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


def front_end(
    pcm, sizes=(2048,), fft_size=2048, hop=96, limit=20000, center=None, source=-1
):
    """Explicit end-grid; alignment changes window geometry, never fitted traces."""
    span = max(sizes) if center is None else max(max(sizes), 2 * center)
    padded = np.pad(pcm.astype(np.float64), (span, 0))
    frames = np.lib.stride_tricks.sliding_window_view(padded, span)[hop::hop]
    centers = span // 2 if center is None else span - center
    edges = (
        [0, limit + 1]
        if len(sizes) == 1
        else [10, 80, 500, 1250, 2540, 4050, limit + 1]
    )
    frequencies, powers = [], []
    for index, size in enumerate(sizes):
        lo = max(1, int(np.ceil(edges[index] * fft_size / 48000)))
        hi = min(fft_size // 2 + 1, int(np.ceil(edges[index + 1] * fft_size / 48000)))
        offset = centers - size // 2
        window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(size) / size)
        spectrum = np.fft.rfft(frames[:, offset : offset + size] * window, n=fft_size)
        powers.append(
            np.abs(spectrum[:, lo:hi]) ** 2
            * (2 * (2 / 2e-5) ** 2 / (fft_size * np.sum(window**2)))
        )
        frequencies.extend(np.arange(lo, hi) * 48000 / fft_size)
    header = np.array([len(frequencies), 48000 / hop, *frequencies], dtype="<f8")
    spectrum = np.concatenate(powers, axis=1).astype("<f8")
    values = binary(
        [".cache/partial-oracle-run", "--grid", str(source)],
        header.tobytes() + spectrum.tobytes(),
        len(frequencies) + 25 * 149 + 24 * 149 + 48,
    )
    return values[:, -24:]


def summarize(values, hop=96):
    band = int(np.argmax(values.mean(axis=0)))
    curve = values[:, band]
    times = (np.arange(len(curve)) + 1) * hop / 48000
    steady = float(curve[(times >= 1) & (times < 1.2)].mean())
    above = np.flatnonzero(curve >= steady * 0.9)
    return {
        "dominantBand": band,
        "steadySones": steady,
        "rise90Ms": float((times[above[0]] - 0.4) * 1000)
        if steady > 0 and len(above)
        else None,
        "peakSones": float(curve.max()),
    }


def compare_historical(cases):
    history = json.loads(Path("docs/audio-audit-results/windows.json").read_text())
    for previous, current in zip(history["cases"], cases, strict=True):
        assert previous["frequencyHz"] == current["frequencyHz"]
        assert previous["pcmSha256"] == current["pcmSha256"]
        for path in ["fixed", "sixWindow"]:
            for key in ["steadySones", "rise90Ms", "fall10Ms"]:
                assert abs(previous[path][key] - current[path][key]) < 1e-8
    return len(cases)


def controls():
    six = (3072, 1536, 768, 384, 192, 96)
    variants = {
        "productionGeometry": {},
        "window64msGrid4096": {"sizes": (3072,), "fft_size": 4096},
        "window32ms": {"sizes": (1536,), "fft_size": 2048},
        "gridOnly4096": {"fft_size": 4096},
        "gridOnly8192": {"fft_size": 8192},
        "coverageOnly15kHz": {"limit": 15000},
        "updateOnly1ms": {"hop": 48},
        "alignmentOnly32ms": {"center": 1536},
        "sixWindow": {"sizes": six, "fft_size": 4096, "hop": 48, "limit": 15000},
        "knownSourceFixed": {"source": 16},
        "knownSourceSixWindow": {
            "sizes": six,
            "fft_size": 4096,
            "hop": 48,
            "limit": 15000,
            "source": 16,
        },
    }
    pcm = np.concatenate([np.zeros(19200), tone(3400, 0.8), np.zeros(19200)]).astype(
        "<f4"
    )
    tone_result = {
        name: {
            "parameters": params,
            **summarize(front_end(pcm, **params), params.get("hop", 96)),
        }
        for name, params in variants.items()
    }
    # Window-size isolation uses one common FFT grid and center for all lengths.
    isolated = {
        str(size): summarize(front_end(pcm, sizes=(size,), fft_size=4096, center=1536))
        for size in [1536, 2048, 3072]
    }
    rng = np.random.default_rng(20261001)
    corpus = {
        f"boundary-{frequency:g}": np.concatenate(
            [np.zeros(19200), tone(frequency, 0.8), np.zeros(19200)]
        ).astype("<f4")
        for frequency in [100, 1080, 3150, 3700, 9500, 12000, 15500]
    }
    corpus.update(
        {
            "burst10ms": np.concatenate(
                [np.zeros(19200), tone(3400, 0.01), np.zeros(37920)]
            ).astype("<f4"),
            "noise": np.concatenate(
                [np.zeros(19200), rng.normal(0, 0.01, 38400), np.zeros(19200)]
            ).astype("<f4"),
            "nearMasker": np.concatenate(
                [
                    np.zeros(19200),
                    tone(1000, 0.8, 0.0002) + tone(1170, 0.8, 0.02),
                    np.zeros(19200),
                ]
            ).astype("<f4"),
            "separatedSources": np.concatenate(
                [
                    np.zeros(19200),
                    tone(250, 0.8, 0.01) + tone(3400, 0.8, 0.02),
                    np.zeros(19200),
                ]
            ).astype("<f4"),
        }
    )
    for clip in ["trumpet", "music"]:
        corpus[clip] = np.fromfile(
            f"musical-leptos/public/review/{clip}.f32", dtype="<f4"
        )
    coverage = []
    for name, samples in corpus.items():
        fixed = front_end(samples)
        reference = front_end(samples, sizes=six, fft_size=4096, hop=48, limit=15000)
        rust = binary(
            ["target/release/examples/partial_trace"],
            samples.tobytes(),
            49,
        )[:, -24:]
        np.testing.assert_allclose(rust, fixed, atol=2e-5, rtol=2e-5)
        coverage.append(
            {
                "name": name,
                "pcmSha256": hashlib.sha256(samples).hexdigest(),
                "currentBuildMatchesFixed": True,
                "fixed": summarize(fixed),
                "sixWindow": summarize(reference, 48),
                "maxBandDifferenceSones": float(np.abs(fixed - reference[1::2]).max()),
            }
        )
    return {
        "tone3400Hz": tone_result,
        "windowLengthSameGridAndCenter": isolated,
        "coverage": coverage,
        "interpretation": "source partial loudness, not total ISO loudness or human perceptual error; no fitted gain or time shift",
    }


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
    (output / "current-windows.json").write_text(
        json.dumps(
            {
                "upstreamRevision": REVISION,
                "productionWasmSha256": hashlib.sha256(
                    Path("musical-lights-worklet/pkg/loudness.wasm").read_bytes()
                ).hexdigest(),
                "productionDspSourceSha256": hashlib.sha256(
                    Path("musical-lights-core/src/audio/partial/mod.rs").read_bytes()
                ).hexdigest(),
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
                "controls": controls(),
                "historicalCasesReproduced": compare_historical(cases),
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
