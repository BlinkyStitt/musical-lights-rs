"""Independent stage, streaming, selectivity and latency checks for source bands."""

import json
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
REVISION = "82de790f79c5b358040861e8bdb906a55009b117"
BINS = 853
FILTERS = 149
STRIDE = BINS + 25 * FILTERS + 24 * FILTERS + 48
CENTERS = np.array(
    [
        50,
        150,
        250,
        350,
        450,
        570,
        700,
        840,
        1000,
        1170,
        1370,
        1600,
        1850,
        2150,
        2500,
        2900,
        3400,
        4050,
        4800,
        5800,
        7000,
        8600,
        10700,
        13700,
    ]
)
EDGES = np.array(
    [
        100,
        200,
        300,
        400,
        510,
        630,
        770,
        920,
        1080,
        1270,
        1480,
        1720,
        2000,
        2320,
        2700,
        3150,
        3700,
        4400,
        5300,
        6400,
        7700,
        9500,
        12000,
    ]
)


def binary(command, data, stride):
    result = subprocess.run(
        command, input=data, stdout=subprocess.PIPE, check=True, cwd=ROOT
    )
    return np.frombuffer(result.stdout, dtype="<f8").reshape(-1, stride)


def build_oracle():
    checkout = ROOT / ".cache/partial-oracle"
    if not checkout.exists():
        subprocess.run(
            ["git", "clone", "https://github.com/deeuu/loudness.git", str(checkout)],
            check=True,
        )
        subprocess.run(["git", "-C", str(checkout), "checkout", REVISION], check=True)
    assert (
        subprocess.check_output(
            ["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True
        ).strip()
        == REVISION
    )
    assert not subprocess.check_output(
        ["git", "-C", str(checkout), "diff", "--name-only"], text=True
    ).strip()
    units = [
        "support/SignalBank",
        "support/Module",
        "support/AuditoryTools",
        "thirdParty/spline/Spline",
        "modules/WeightSpectrum",
        "modules/MultiSourceRoexBank",
        "modules/SpecificPartialLoudnessMGB1997",
        "modules/InstantaneousLoudness",
        "modules/ARAverager",
    ]
    subprocess.run(
        [
            "clang++",
            "-std=c++11",
            "-O3",
            "-I",
            str(checkout / "src"),
            "validation/partial/oracle.cpp",
            *[str(checkout / "src" / f"{unit}.cpp") for unit in units],
            "-o",
            ".cache/partial-oracle-run",
        ],
        check=True,
        cwd=ROOT,
    )


def tone(frequency, seconds=1.0, amplitude=0.02):
    time = np.arange(round(seconds * 48000)) / 48000
    return (np.sin(2 * np.pi * frequency * time) * amplitude).astype("<f4")


def spectral_frames(pcm):
    window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(2048) / 2048)
    padded = np.pad(pcm.astype(np.float64), (2048, 0))
    frames = np.lib.stride_tricks.sliding_window_view(padded, 2048)[96::96]
    # One-sided component mean square, calibrated to the existing 2 Pa/unit.
    spectrum = np.abs(np.fft.rfft(frames * window, axis=1)[:, 1:854]) ** 2
    return spectrum * (2 * (2 / 2e-5) ** 2 / (2048 * np.sum(window**2)))


def pcm_reference(rust, rng):
    burst = np.concatenate(
        [np.zeros(12000), tone(1000, 0.025), np.zeros(34800)]
    ).astype("<f4")
    step = np.concatenate([np.zeros(24000), tone(1000, 0.5)]).astype("<f4")
    cases = {
        "burst": burst,
        "step": step,
        "broadband": rng.normal(0, 0.01, 24000).astype("<f4"),
        "nearMasker": tone(1000, 0.5, 0.0002) + tone(1170, 0.5, 0.02),
        "separated": tone(250, 0.5, 0.01) + tone(3400, 0.5, 0.02),
        "silence": np.zeros(24000, dtype="<f4"),
    }
    results = []
    latency = {}
    for name, pcm in cases.items():
        spectra = spectral_frames(pcm)
        expected = binary(
            [".cache/partial-oracle-run"], spectra.astype("<f8").tobytes(), STRIDE
        )[:, -48:]
        actual = binary([rust, "pcm"], pcm.tobytes(), 49)
        delta = np.abs(actual[:, 1:] - expected)
        results.append(
            {
                "case": name,
                "maxErrorSones": float(delta.max()),
                "pass": bool(np.all(delta <= 2e-5 + 2e-5 * np.abs(expected))),
            }
        )
        if name == "step":
            energy = spectra.sum(axis=1)
            instant = actual[:, 1:25].sum(axis=1)
            short = actual[:, 25:].sum(axis=1)
            for label, curve in [
                ("windowEnergy", energy),
                ("instantaneous", instant),
                ("shortTerm", short),
            ]:
                for fraction in [0.1, 0.5, 0.9]:
                    index = int(
                        np.flatnonzero(curve >= curve[-20:].mean() * fraction)[0]
                    )
                    latency[f"{label}{int(fraction * 100)}PercentMs"] = float(
                        actual[index, 0] / 48 - 500
                    )
    return results, latency


def masking_and_equal_loudness(rust):
    def calculate(powers, executable):
        return binary(
            executable, np.tile(powers, (100, 1)).astype("<f8").tobytes(), STRIDE
        )[-1, -48:-24]

    target = np.zeros(BINS)
    target[42] = 1e4
    masked = target.copy()
    masked[49] = 1e7
    alone = calculate(target, [rust, "spectrum"])[8]
    mixed = calculate(masked, [rust, "spectrum"])[8]
    oracle_ratio = (
        calculate(masked, [".cache/partial-oracle-run"])[8]
        / calculate(target, [".cache/partial-oracle-run"])[8]
    )
    masking = {
        "ratio": float(mixed / alone),
        "referenceRatio": float(oracle_ratio),
        "pass": bool(mixed < alone and abs(mixed / alone - oracle_ratio) < 1e-7),
    }
    equal = []
    for band, frequency in [(2, 250), (8, 1000), (17, 4050)]:
        bin_index = round(frequency / (48000 / 2048)) - 1
        low, high = 1e2, 1e9
        for _ in range(24):
            value = np.sqrt(low * high)
            spectrum = np.zeros(BINS)
            spectrum[bin_index] = value
            loudness = calculate(spectrum, [".cache/partial-oracle-run"])[band]
            if loudness < 1:
                low = value
            else:
                high = value
        measured = calculate(spectrum, [rust, "spectrum"])[band]
        equal.append(
            {
                "frequency": frequency,
                "componentPower": float(value),
                "referenceSones": float(loudness),
                "measuredSones": float(measured),
                "pass": bool(
                    abs(measured - 1) < 1e-5 and abs(measured - loudness) < 1e-7
                ),
            }
        )
    return masking, equal


def sweeps(rust):
    results = []
    time = np.arange(24 * 48000) / 48000
    for direction in ["up", "down"]:
        frequencies = 50 * (13700 / 50) ** (
            time / 24 if direction == "up" else 1 - time / 24
        )
        phase = np.cumsum(2 * np.pi * frequencies / 48000)
        pcm = (0.02 * np.sin(phase)).astype("<f4")
        rows = binary([rust, "pcm"], pcm.tobytes(), 49)
        # Causal window center, fixed in advance; no fitting of response delay.
        indices = np.maximum(0, rows[:, 0].astype(int) - 1024)
        bands = np.searchsorted(EDGES, frequencies[indices])
        worst = 0.0
        for row, band in zip(rows[250:], bands[250:], strict=True):
            values = row[25:]
            peak = values.max()
            outside = values[np.abs(np.arange(24) - band) > 1]
            worst = max(worst, float(outside.max() / peak))
        results.append(
            {
                "direction": direction,
                "seconds": 24,
                "maxNonadjacentOverPeak": worst,
                "pass": worst < 0.1,
            }
        )
    return results


def main():
    build_oracle()
    rust = str(ROOT / "target/release/examples/partial_trace")
    rng = np.random.default_rng(1997)
    # Spectral inputs are identical, including silence, weak targets/maskers,
    # separated tones, equal component levels, broadband and burst envelopes.
    spectra = []
    for frequency in CENTERS:
        power = np.zeros(BINS)
        power[round(frequency / (48000 / 2048)) - 1] = 1e6
        spectra.extend([power] * 25)
    for masker in [1e2, 1e6, 1e9, 2e10]:
        power = np.zeros(BINS)
        power[42] = 1e4
        power[49] = masker
        power[145] = 1e5
        spectra.extend([power] * 25)
    spectra.extend(rng.uniform(0, 1e5, (100, BINS)))
    spectra.extend([np.zeros(BINS)] * 200)
    raw = np.asarray(spectra, dtype="<f8").tobytes()
    expected = binary([".cache/partial-oracle-run"], raw, STRIDE)
    actual = binary([rust, "spectrum"], raw, STRIDE)
    boundaries = [0, BINS, BINS + 25 * FILTERS, STRIDE - 48, STRIDE - 24, STRIDE]
    stages = {}
    for name, start, end in zip(
        ["earWeight", "excitation", "specificPartial", "instantaneous", "shortTerm"],
        boundaries,
        boundaries[1:],
        strict=False,
    ):
        difference = np.abs(actual[:, start:end] - expected[:, start:end])
        tolerance = 1e-8 + 2e-7 * np.abs(expected[:, start:end])
        stages[name] = {
            "maxAbsoluteError": float(difference.max()),
            "pass": bool(np.all(difference <= tolerance)),
        }
    callback = np.concatenate(
        [tone(1000, 0.3), np.zeros(5000, dtype="<f4"), tone(150, 0.2)]
    )
    reference = binary([rust, "pcm", "128"], callback.tobytes(), 49)
    callback_pass = all(
        np.array_equal(
            reference, binary([rust, "pcm", str(size)], callback.tobytes(), 49)
        )
        for size in [1, 96, 240, 4096]
    )
    centers = []
    for band, frequency in enumerate(CENTERS):
        result = binary([rust, "pcm"], tone(frequency).tobytes(), 49)
        values = result[-100:, 25:].mean(axis=0)
        ratio = float(values[band] / values.sum())
        centers.append(
            {
                "frequency": int(frequency),
                "intendedBand": band,
                "fraction": ratio,
                "pass": ratio >= 0.9,
            }
        )
    boundaries_result = []
    for band, frequency in enumerate(EDGES):
        result = binary([rust, "pcm"], tone(frequency).tobytes(), 49)
        values = result[-100:, 25:].mean(axis=0)
        outside = np.delete(values, [band, band + 1])
        ratio = float(outside.max() / values.max())
        boundaries_result.append(
            {
                "frequency": int(frequency),
                "maxNonadjacentOverPeak": ratio,
                "pass": ratio < 0.1,
            }
        )
    pcm_cases, latency = pcm_reference(rust, rng)
    masking, equal = masking_and_equal_loudness(rust)
    sweep_results = sweeps(rust)
    report = {
        "oracle": REVISION,
        "configuration": {
            "presentation": "monaural",
            "outerEar": "free field",
            "middleEar": "ANSI full response without separate HPF",
            "camStep": 0.25,
            "ansi2007HighLevelExtension": False,
            "temporal": "GM2002 short term",
            "fft": 2048,
            "hop": 96,
        },
        "stages": stages,
        "callbackIndependent": callback_pass,
        "centers": centers,
        "boundaries": boundaries_result,
        "finite": bool(np.isfinite(actual).all()),
        "nonnegative": bool((actual >= 0).all()),
        "pcmReference": pcm_cases,
        "stepLatency": latency,
        "masking": masking,
        "equalLoudness": equal,
        "sweeps": sweep_results,
    }
    report["pass"] = (
        all(stage["pass"] for stage in stages.values())
        and callback_pass
        and all(row["pass"] for row in centers + boundaries_result)
        and report["finite"]
        and report["nonnegative"]
        and masking["pass"]
        and all(row["pass"] for row in pcm_cases + equal + sweep_results)
    )
    destination = ROOT / "docs/partial-loudness-results"
    destination.mkdir(exist_ok=True)
    (destination / "model.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not report["pass"]:
        raise SystemExit("Partial-loudness promotion blocked: see model.json")


if __name__ == "__main__":
    main()
