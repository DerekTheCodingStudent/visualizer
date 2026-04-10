#!/usr/bin/env python3

import json
import random
import argparse
import time
from pathlib import Path

# ---- Argument Parsing ----

parser = argparse.ArgumentParser(
    description="Generate a large JSON chart file of specified size (in MB)."
)
parser.add_argument(
    "mb",
    nargs="?",
    type=float,
    default=1,
    help="Target size in megabytes (default: 1)"
)
parser.add_argument(
    "--seed",
    type=int,
    default=None,
    help="RNG seed (default: time(NULL))",
)
args = parser.parse_args()

seed = args.seed if args.seed is not None else int(time.time())
random.seed(seed)

TARGET_SIZE_BYTES = int(args.mb * 1_000_000)

# ---- Paths ----

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = "data"
OUTPUT_FILE = SCRIPT_DIR / DATA_DIR / f"large_chart_{args.mb}mWb.json"
OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

# ---- Chart Template ----

legend = [
    {"name": "GPU-only",        "color": [0.1, 0.8, 1.0, 1.0]},
    {"name": "CPU-only",        "color": [1.0, 0.6, 0.1, 1.0]},
    {"name": "GPU/CPU overlap", "color": [0.6, 0.4, 1.0, 1.0]},
    {"name": "Data wait",       "color": [0.5, 0.5, 0.5, 1.0]},
]


def build_record_pool(pool_size=20):
    """Create reusable bar templates to mimic real recurring workload shapes."""
    records = []
    for rid in range(pool_size):
        base_w = random.choice([68, 72, 76, 80, 84, 88, 92])
        base_h = random.randint(90, 220)
        y = random.choice([40, 45, 50, 55, 60])
        # Keep distribution broad so records are visually distinct.
        segment_values = [random.randint(8, 120) for _ in range(4)]
        records.append(
            {
                "recordId": rid,
                "y": y,
                "w": base_w,
                "h": base_h,
                "segmentValues": segment_values,
            }
        )
    return records


def pick_record_index(i, pool_size):
    """
    Non-linear lookup with occasional random jumps:
    - baseline index mixes quadratic and multiplicative terms
    - every ~7th item may hop to a random record
    - every ~11th item may mirror from the end of the pool
    """
    idx = (i * i + 3 * i + 7) % pool_size
    if i % 7 == 0 and random.random() < 0.55:
        idx = random.randint(0, pool_size - 1)
    if i % 11 == 0 and random.random() < 0.4:
        idx = (pool_size - 1) - idx
    return idx


def encode(obj):
    return len(json.dumps(obj, separators=(",", ":")).encode())

# ---- Measure overhead ----

base_chart = {"legend": legend, "bars": []}
base_size = encode(base_chart)

# Measure size of one bar
sample_bar = {
    "x": 0,
    "y": 50,
    "w": 80,
    "h": 120,
    "label": "Run 0",
    "segments": [
        {"value": 50, "legendIndex": 0},
        {"value": 50, "legendIndex": 1},
        {"value": 50, "legendIndex": 2},
        {"value": 50, "legendIndex": 3},
    ],
}

one_bar_size = encode({"legend": legend, "bars": [sample_bar]}) - base_size

if one_bar_size <= 0:
    raise RuntimeError("Bar size measurement failed.")

# ---- Compute number of bars ----

bars_needed = max((TARGET_SIZE_BYTES - base_size) // one_bar_size, 0)

print(f"Target size: {TARGET_SIZE_BYTES/1024:.1f} KB")
print(f"Base size: {base_size} bytes")
print(f"Per-bar size (approx): {one_bar_size} bytes")
print(f"Bars needed: {bars_needed}")
print(f"Seed: {seed}")

# ---- Generate bars ----

bars = []
x_start = -5000
x_spacing = 90
record_pool = build_record_pool(pool_size=20)

for i in range(int(bars_needed)):
    record_idx = pick_record_index(i, len(record_pool))
    template = record_pool[record_idx]
    segment_values = template["segmentValues"]
    segments = [
        {"value": value, "legendIndex": idx}
        for idx, value in enumerate(segment_values)
    ]
    bars.append({
        "x": x_start + i * x_spacing,
        "y": template["y"],
        "w": template["w"],
        "h": template["h"],
        "label": f"Run {i} (r{record_idx})",
        "segments": segments,
    })

# ---- Final encode ----

final_json = json.dumps(
    {"legend": legend, "bars": bars},
    separators=(",", ":")
).encode()

with open(OUTPUT_FILE, "wb") as f:
    f.write(final_json)

print(f"Final size: {len(final_json)/1024:.2f} KB")
print(f"Bars generated: {len(bars)}")
print(f"Output: {OUTPUT_FILE}")