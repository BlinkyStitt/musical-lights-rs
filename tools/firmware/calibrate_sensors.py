"""Collect native SI samples, fit a calibration, and stage it for fixture review."""

import argparse
import binascii
import csv
import hashlib
import json
import math
import struct
import time
from pathlib import Path

import numpy as np
from codec import calibration_event
from provision import Console
from scipy.optimize import least_squares

GRAVITY = 9.80665


def fit_magnetometer(samples):
    samples = np.asarray(samples, dtype=float)
    if (
        samples.ndim != 2
        or samples.shape[1] != 3
        or len(samples) < 360
        or not np.isfinite(samples).all()
    ):
        raise ValueError("Need at least 360 finite native magnetometer samples")
    holdout = np.arange(len(samples)) % 5 == 4
    train, test = samples[~holdout], samples[holdout]
    variance = train.var(axis=0)
    if np.any(variance <= 0):
        raise ValueError("Magnetic coverage has zero variance")
    initial = np.r_[
        np.median(train, axis=0), np.log(np.sqrt(1 / (3 * variance))), np.zeros(3)
    ]

    def unpack(parameters):
        lower = np.diag(np.exp(parameters[3:6]))
        lower[1, 0], lower[2, 0], lower[2, 1] = parameters[6:9]
        return parameters[:3], lower @ lower.T

    def residual(parameters):
        bias, matrix = unpack(parameters)
        centered = train - bias
        return np.einsum("ni,ij,nj->n", centered, matrix, centered) - 1

    solution = least_squares(
        residual,
        initial,
        method="trf",
        loss="linear",
        ftol=1e-10,
        xtol=1e-10,
        gtol=1e-10,
        max_nfev=10000,
    )
    if not solution.success or not np.isfinite(solution.x).all():
        raise ValueError("Ellipsoid fit failed")
    bias, shape = unpack(solution.x)
    eigenvalues, eigenvectors = np.linalg.eigh(shape)
    if np.any(eigenvalues <= 0):
        raise ValueError("Ellipsoid is not positive definite")
    field = np.linalg.det(shape) ** (-1 / 6)
    matrix = field * (eigenvectors @ np.diag(np.sqrt(eigenvalues)) @ eigenvectors.T)
    if not 15 <= field <= 80 or np.linalg.cond(matrix) > 4:
        raise ValueError("Field or matrix condition exceeds the accepted limits")
    corrected = (train - bias) @ matrix.T
    unit = corrected / np.linalg.norm(corrected, axis=1)[:, None]
    z = np.clip(np.floor((unit[:, 2] + 1) * 2).astype(int), 0, 3)
    azimuth = np.arctan2(unit[:, 1], unit[:, 0]) % (2 * math.pi)
    sector = np.clip(np.floor(azimuth / (math.pi / 3)).astype(int), 0, 5)
    bins = np.bincount(z * 6 + sector, minlength=24)
    if np.any(bins < 12):
        raise ValueError(
            "Need at least 12 training samples in each equal-area coverage bin"
        )
    error = np.linalg.norm((test - bias) @ matrix.T, axis=1) - field
    rms, maximum = np.sqrt(np.mean(error**2)), np.max(np.abs(error))
    if rms > field * 0.05 or maximum > field * 0.15:
        raise ValueError("Held-out radial error exceeds the accepted limits")
    return bias, matrix, float(field), float(rms), float(maximum), bins.tolist()


def fit_inertial(rows):
    means = {}
    for pose in ("+x", "-x", "+y", "-y", "+z", "-z"):
        values = np.asarray(
            [
                [float(row[k]) for k in ("ax", "ay", "az")]
                for row in rows
                if row.get("pose") == pose and int(row["valid"]) & 1
            ]
        )
        if len(values) < 100 or not np.isfinite(values).all():
            raise ValueError(
                "Each of six stationary poses needs 100 valid accelerometer samples"
            )
        if np.max(values.std(axis=0)) > GRAVITY * 0.02:
            raise ValueError("Accelerometer pose moved during collection")
        means[pose] = values.mean(axis=0)
    bias, scale = np.zeros(3), np.zeros(3)
    for axis, letter in enumerate("xyz"):
        positive, negative = means[f"+{letter}"][axis], means[f"-{letter}"][axis]
        if positive <= negative:
            raise ValueError("Pose labels or mounting axes are incorrect")
        bias[axis], scale[axis] = (
            (positive + negative) / 2,
            2 * GRAVITY / (positive - negative),
        )
    if np.any(scale < 0.5) or np.any(scale > 2):
        raise ValueError("Accelerometer scale exceeds accepted limits")
    gyro = np.asarray(
        [
            [float(row[k]) for k in ("gx", "gy", "gz")]
            for row in rows
            if row.get("pose") in means and int(row["valid"]) & 2
        ]
    )
    if (
        len(gyro) < 600
        or not np.isfinite(gyro).all()
        or np.max(gyro.std(axis=0)) > math.radians(1)
    ):
        raise ValueError("Need fresh stationary gyro samples in all poses")
    return bias, scale, gyro.mean(axis=0)


def coefficient_record(rows, sensor_profile, mount_revision, revision):
    mag = [
        [float(row[k]) for k in ("mx", "my", "mz")]
        for row in rows
        if int(row["valid"]) & 4 and row.get("pose") == "rotate"
    ]
    bias, matrix, field, rms, maximum, bins = fit_magnetometer(mag)
    accel_bias, accel_scale, gyro_bias = fit_inertial(rows)
    floats = [
        *accel_bias,
        *accel_scale,
        *gyro_bias,
        *bias,
        *matrix.reshape(-1),
        field,
        rms,
        maximum,
    ]
    body = struct.pack(
        "<HHIIIh24fH",
        1,
        sensor_profile,
        mount_revision,
        revision,
        len(mag),
        -32768,
        *floats,
        1,
    )
    record = body + struct.pack("<I", binascii.crc32(body))
    if len(record) != 120:
        raise ValueError("Coefficient record must be 120 bytes")
    return record, {
        "field_microtesla": field,
        "holdout_rms": rms,
        "holdout_max": maximum,
        "training_bins": bins,
        "sha256": hashlib.sha256(record).hexdigest(),
        "fixture_acceptance": "Pending cardinal, tilt, LED-load and radio-TX measurements",
    }


def collect(client, duration, pose, writer):
    reply = client.request("calibration begin")
    if not reply.get("ok"):
        raise ValueError("Cannot begin sensor calibration")
    run = bytes.fromhex(reply["data_hex"])
    if len(run) != 8:
        raise ValueError("Invalid calibration run")
    boot = None
    sequence = 0

    def event(event):
        nonlocal boot, sequence
        if event.get("event") == "console_overflow":
            raise ValueError("Console overflow invalidates this calibration capture")
        if event.get("event") != "calibration":
            return
        current_boot, current_run, current_sequence, rows = calibration_event(event)
        if (
            current_run != run
            or boot is not None
            and current_boot != boot
            or current_sequence != sequence + 1
        ):
            raise ValueError("Calibration stream has a restart or sequence gap")
        boot, sequence = current_boot, current_sequence
        for row in rows:
            writer.writerow({**row, "pose": pose})

    client.events = event
    try:
        client.request(f"calibration stream {run.hex()} on")
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            # Keepalive reads also consume and validate queued sample events.
            client.request(f"calibration stream {run.hex()} on", timeout=10)
            time.sleep(0.1)
    finally:
        client.request(f"calibration stream {run.hex()} off")
        client.request(f"calibration cancel {run.hex()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    fit = sub.add_parser("fit")
    fit.add_argument("csv", nargs="+", type=Path)
    fit.add_argument("--sensor-profile", required=True, type=int)
    fit.add_argument("--mount-revision", required=True, type=int)
    fit.add_argument("--revision", required=True, type=int)
    fit.add_argument("--output", required=True, type=Path)
    capture = sub.add_parser("collect")
    capture.add_argument("--port", required=True)
    capture.add_argument(
        "--pose", choices=["rotate", "+x", "-x", "+y", "-y", "+z", "-z"], required=True
    )
    capture.add_argument("--seconds", type=float, default=30)
    capture.add_argument("--output", type=Path, required=True)
    stage = sub.add_parser("stage")
    stage.add_argument("--port", required=True)
    stage.add_argument("--run", required=True)
    stage.add_argument("candidate", type=Path)
    args = parser.parse_args()
    if args.action == "fit":
        rows = []
        for path in args.csv:
            with path.open() as source:
                rows.extend(csv.DictReader(source))
        record, report = coefficient_record(
            rows, args.sensor_profile, args.mount_revision, args.revision
        )
        args.output.write_bytes(record)
        args.output.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
    else:
        import serial

        with serial.Serial(args.port, 115200, timeout=0.25) as transport:
            client = Console(transport)
            if args.action == "stage":
                record = args.candidate.read_bytes()
                if len(record) != 120 or binascii.crc32(record[:-4]) != int.from_bytes(
                    record[-4:], "little"
                ):
                    raise ValueError("Invalid coefficient candidate")
                print(
                    json.dumps(
                        client.request(f"calibration stage {args.run} {record.hex()}")
                    )
                )
            else:
                with args.output.open("x", newline="") as output:
                    writer = csv.DictWriter(
                        output,
                        fieldnames=[
                            "captured_ms",
                            "valid",
                            "ax",
                            "ay",
                            "az",
                            "gx",
                            "gy",
                            "gz",
                            "mx",
                            "my",
                            "mz",
                            "pose",
                        ],
                    )
                    writer.writeheader()
                    collect(client, args.seconds, args.pose, writer)


if __name__ == "__main__":
    main()
