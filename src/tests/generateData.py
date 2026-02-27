import json
import random
import time
from pathlib import Path

TARGET_SIZE_BYTES = 1_000_000
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_FILE = SCRIPT_DIR / "large_chart.json"

legend = [
    {"name": "GPU-only",        "color": [0.1, 0.8, 1.0, 1.0]},
    {"name": "CPU-only",        "color": [1.0, 0.6, 0.1, 1.0]},
    {"name": "GPU/CPU overlap", "color": [0.6, 0.4, 1.0, 1.0]},
    {"name": "Data wait",       "color": [0.5, 0.5, 0.5, 1.0]},
]

bars = []
x_start = -5000
x_spacing = 90
bar_width = 80
bar_height = 120
y_base = 50

start_time = time.time()
last_update = start_time

def encode_size():
    chart = {"legend": legend, "bars": bars}
    return len(json.dumps(chart, separators=(",", ":")).encode())

def print_progress(current_size):
    elapsed = time.time() - start_time
    progress = current_size / TARGET_SIZE_BYTES
    progress = min(progress, 1.0)

    if progress > 0:
        total_estimated = elapsed / progress
        eta = total_estimated - elapsed
    else:
        eta = 0

    bar_len = 40
    filled = int(bar_len * progress)
    bar = "#" * filled + "-" * (bar_len - filled)

    print(
        f"\r[{bar}] {progress*100:6.2f}% "
        f"{current_size/1024:8.1f} KB / {TARGET_SIZE_BYTES/1024:.1f} KB "
        f"ETA: {eta:6.1f}s",
        end="",
        flush=True,
    )

# ---- Phase 1: Grow steadily with size checks ----

i = 0
current_size = encode_size()

while current_size < TARGET_SIZE_BYTES:
    segments = [random.randint(5, 100) for _ in range(4)]

    bars.append({
        "x": x_start + i * x_spacing,
        "y": y_base,
        "w": bar_width,
        "h": bar_height,
        "label": f"Run {i}",
        "segments": segments,
    })

    i += 1

    # Check size every 100 bars (safe + efficient)
    if i % 100 == 0:
        current_size = encode_size()

        now = time.time()
        if now - last_update >= 1:
            print_progress(current_size)
            last_update = now

# ---- Phase 2: Fine trim (remove overflow) ----

while True:
    current_size = encode_size()
    if current_size <= TARGET_SIZE_BYTES:
        break
    bars.pop()

# ---- Write final file ----

final_json = json.dumps(
    {"legend": legend, "bars": bars},
    separators=(",", ":")
).encode()

with open(OUTPUT_FILE, "wb") as f:
    f.write(final_json)

print_progress(len(final_json))
print("\nDone.")
print(f"Bars generated: {len(bars)}")
print(f"Final size: {len(final_json)/1024:.2f} KB")
print(f"Output: {OUTPUT_FILE}")