"""Compare every controlled-tone specific-loudness value with pinned MoSQITo."""

import json
import sys
from pathlib import Path

import numpy as np
from mosqito.sq_metrics import loudness_zwtv
from validate import limits


def main():
    directory = Path(sys.argv[1])
    summaries = json.loads((directory / "summary.json").read_text())
    reports = []
    for summary in summaries:
        kind = summary["kind"]
        pcm = np.fromfile(directory / f"{kind}.f32", dtype="<f4")
        rows = np.fromfile(directory / f"{kind}.f64", dtype="<f8").reshape(
            -1, summary["stride"]
        )
        total, specific, _, _ = loudness_zwtv(
            pcm.astype(np.float64) * 2, 48000, field_type="free"
        )
        count = len(rows)
        # MoSQiTo labels its fixed 2 ms grid with linspace including the
        # input endpoint. Compare by exact frame index, without fitting a delay.
        np.testing.assert_array_equal(rows[:, 0], np.arange(count) * 96)
        total_result = limits(rows[:, 1], total[:count])
        specific_result = limits(rows[:, 2:242], specific[:, :count].T)
        integrated = specific[:, :count].T.reshape(count, 24, 10).sum(axis=2) * 0.1
        bands_result = limits(rows[:, 242:266], integrated)
        assert (
            total_result["passed"]
            and specific_result["passed"]
            and bands_result["passed"]
        )
        report = {
            "kind": kind,
            "frames": count,
            "total": total_result,
            "specific": specific_result,
            "bands": bands_result,
            "specific_values": count * 240,
            "total_max_error": float(np.max(np.abs(rows[:, 1] - total[:count]))),
            "specific_max_error": float(
                np.max(np.abs(rows[:, 2:242] - specific[:, :count].T))
            ),
            "bands_max_error": float(np.max(np.abs(rows[:, 242:266] - integrated))),
        }
        reports.append(report)
        print(json.dumps(report), flush=True)
    (directory / "oracle.json").write_text(json.dumps(reports, indent=2) + "\n")


if __name__ == "__main__":
    main()
