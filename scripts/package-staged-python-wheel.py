#!/usr/bin/env python3
"""Create a deterministic binary wheel from an audited staged package.

This intentionally accepts explicit top-level paths instead of packing an
entire site-packages directory. It is used for cross-built extensions which
cannot be imported on the build host, after their native dependency closure
has been audited separately.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
from pathlib import Path
import stat
import zipfile


ARCHIVE_TIMESTAMP = (2026, 1, 1, 0, 0, 0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-packages", type=Path, required=True)
    parser.add_argument("--package", action="append", default=[])
    parser.add_argument("--module", action="append", default=[])
    parser.add_argument("--dist-info", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def checked_child(root: Path, name: str) -> Path:
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError(f"unsafe staged package name: {name!r}")
    child = root / name
    if not child.is_dir() or child.is_symlink():
        raise ValueError(f"staged package directory is missing or unsafe: {name}")
    return child


def checked_module(root: Path, name: str) -> Path:
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError(f"unsafe staged module name: {name!r}")
    child = root / name
    if not child.is_file() or child.is_symlink():
        raise ValueError(f"staged module is missing or unsafe: {name}")
    return child


def digest(data: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={encoded.decode('ascii')}"


def archive_info(name: str, executable: bool = False) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, ARCHIVE_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    mode = 0o755 if executable else 0o644
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.create_system = 3
    return info


def main() -> None:
    args = parse_args()
    root = args.site_packages.resolve(strict=True)
    dist_info = checked_child(root, args.dist_info)
    roots = [checked_child(root, name) for name in [*args.package, args.dist_info]]
    modules = [checked_module(root, name) for name in args.module]
    wheel_path = dist_info / "WHEEL"
    wheel_bytes = (
        "Wheel-Version: 1.0\n"
        "Generator: himmelcad-package-staged-python-wheel@1\n"
        "Root-Is-Purelib: false\n"
        f"Tag: {args.tag}\n"
    ).encode("utf-8")

    entries: dict[str, tuple[bytes, bool]] = {}
    for package_root in roots:
        for path in sorted(package_root.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"symbolic links are not allowed in a wheel: {path}")
            if not path.is_file() or path == wheel_path or path.name == "RECORD":
                continue
            relative = path.relative_to(root).as_posix()
            entries[relative] = (path.read_bytes(), bool(path.stat().st_mode & 0o111))
    for module in modules:
        entries[module.name] = (module.read_bytes(), bool(module.stat().st_mode & 0o111))
    entries[f"{args.dist_info}/WHEEL"] = (wheel_bytes, False)

    record_path = f"{args.dist_info}/RECORD"
    record_buffer = io.StringIO(newline="")
    writer = csv.writer(record_buffer, lineterminator="\n")
    for name in sorted(entries):
        data = entries[name][0]
        writer.writerow((name, digest(data), len(data)))
    writer.writerow((record_path, "", ""))
    entries[record_path] = (record_buffer.getvalue().encode("utf-8"), False)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(f"{args.output.suffix}.tmp")
    if temporary.exists():
        temporary.unlink()
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            allowZip64=True,
        ) as wheel:
            for name in sorted(entries):
                data, executable = entries[name]
                wheel.writestr(archive_info(name, executable), data)
        temporary.replace(args.output)
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == "__main__":
    main()
