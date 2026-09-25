"""Samples ~400k coloured points from the Orscholz road scan into public/cloud.bin.

Format: b"HCPT", u32 count, 3 x f64 origin (x, y, z), count x 3 f32 local xyz, count x 3 u8 rgb.
The source LAS stays read-only; nothing is copied besides the sample.
"""
import pathlib
import struct

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCE = ROOT / "libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las"
TARGET = pathlib.Path(__file__).resolve().parents[1] / "public/cloud.bin"
TARGET_POINTS = 400_000

with SOURCE.open("rb") as handle:
    header = handle.read(375)
offset = struct.unpack("<I", header[96:100])[0]
record_length = struct.unpack("<H", header[105:107])[0]
count = struct.unpack("<I", header[107:111])[0]
scale = struct.unpack("<3d", header[131:155])
origin = struct.unpack("<3d", header[155:179])
assert header[104] & 0x3F == 2 and record_length == 30, "expects LAS point format 2 with 30-byte records"

record = np.dtype([
    ("x", "<i4"), ("y", "<i4"), ("z", "<i4"), ("intensity", "<u2"), ("bits", "u1"),
    ("classification", "u1"), ("angle", "i1"), ("user", "u1"), ("source", "<u2"),
    ("r", "<u2"), ("g", "<u2"), ("b", "<u2"), ("pad", "V4"),
])
points = np.memmap(SOURCE, dtype=record, mode="r", offset=offset, shape=(count,))
sample = np.array(points[:: max(1, count // TARGET_POINTS)])
x = sample["x"] * scale[0] + origin[0]
y = sample["y"] * scale[1] + origin[1]
z = sample["z"] * scale[2] + origin[2]
cx, cy, cz = (x.min() + x.max()) / 2, (y.min() + y.max()) / 2, float(np.percentile(z, 2))
xyz = np.stack([x - cx, y - cy, z - cz], 1).astype("<f4")
rgb = np.stack([sample["r"], sample["g"], sample["b"]], 1).astype("f8")
rgb = (rgb / (257.0 if rgb.max() > 255 else 1.0)).clip(0, 255).astype("u1")
TARGET.parent.mkdir(parents=True, exist_ok=True)
TARGET.write_bytes(struct.pack("<4sI3d", b"HCPT", len(xyz), cx, cy, cz) + xyz.tobytes() + rgb.tobytes())
print(f"wrote {len(xyz)} points to {TARGET}")
