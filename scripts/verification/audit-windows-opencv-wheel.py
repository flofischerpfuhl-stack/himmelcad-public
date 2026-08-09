#!/usr/bin/env python3
"""Fail-closed static audit for the cross-built Windows OpenCV wheel."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
import zipfile


PE_SUFFIXES = {".dll", ".pyd"}
EXPECTED_DIST_INFO = "himmelcad_opencv_headless-4.13.0.dist-info"
EXPECTED_WHEEL_NAME = (
    "himmelcad_opencv_headless-4.13.0-cp312-cp312-win_amd64.whl"
)
EXPECTED_PYD = "cv2/python-3.12/cv2.cp312-win_amd64.pyd"
EXPECTED_LICENSE_EXPRESSION = (
    "Apache-2.0 AND (Apache-2.0 WITH LLVM-exception) AND BSD-2-Clause AND "
    "BSD-3-Clause AND HPND AND IJG AND ISC AND LicenseRef-Cephes-MinGW-w64 "
    "AND MIT AND SunPro AND ZPL-2.1 AND Zlib AND libpng-2.0 AND libtiff"
)
REQUIRED_LICENSE_SUFFIXES = {
    "licenses/opencv/LICENSE",
    "licenses/libjpeg-turbo/LICENSE.md",
    "licenses/libjpeg-turbo/README.ijg",
    "licenses/libpng/LICENSE",
    "licenses/libtiff/LICENSE.md",
    "licenses/libwebp/COPYING",
    "licenses/zlib/LICENSE",
    "licenses/dlpack/LICENSE",
    "licenses/softfloat/COPYING.txt",
    "licenses/llvm/LICENSE.TXT",
    "licenses/mingw-w64/COPYING.MinGW-w64-runtime.txt",
    "licenses/mingw-w64/COPYING.winpthreads.txt",
}
SYSTEM_DLLS = {
    "advapi32.dll",
    "bcrypt.dll",
    "cfgmgr32.dll",
    "comctl32.dll",
    "comdlg32.dll",
    "crypt32.dll",
    "dwmapi.dll",
    "gdi32.dll",
    "imm32.dll",
    "kernel32.dll",
    "msvcrt.dll",
    "ntdll.dll",
    "ole32.dll",
    "oleaut32.dll",
    "rpcrt4.dll",
    "secur32.dll",
    "setupapi.dll",
    "shell32.dll",
    "shlwapi.dll",
    "ucrtbase.dll",
    "user32.dll",
    "uuid.dll",
    "version.dll",
    "winmm.dll",
    "ws2_32.dll",
}
EXTERNAL_RUNTIME_DLLS = {"python312.dll"}
FORBIDDEN_IMPORT = re.compile(
    r"(?:avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale|ffmpeg|"
    r"gstreamer|gst[a-z0-9_-]*|opencv_(?:dnn|highgui|videoio)|openblas|"
    r"(?:^|[-_])blas|lapack|gfortran|quadmath|gomp|iomp|vcomp|openmp|"
    r"ipp|opencl|cuda|cudnn|qt[0-9]?|gtk)",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--objdump", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def checked_members(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    members = archive.infolist()
    seen: set[str] = set()
    for member in members:
        path = PurePosixPath(member.filename)
        if path.is_absolute() or not path.parts or ".." in path.parts:
            raise ValueError(f"unsafe wheel member: {member.filename!r}")
        folded = member.filename.casefold()
        if folded in seen:
            raise ValueError(f"duplicate wheel member: {member.filename!r}")
        seen.add(folded)
        mode = member.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise ValueError(f"symbolic links are not allowed: {member.filename}")
    return members


def is_system_dll(name: str) -> bool:
    folded = name.casefold()
    return (
        folded in SYSTEM_DLLS
        or folded.startswith("api-ms-win-")
        or folded.startswith("ext-ms-win-")
    )


def inspect_pe(objdump: Path, binary: Path) -> tuple[list[str], str]:
    result = subprocess.run(
        [str(objdump), "-p", str(binary)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"llvm-objdump rejected {binary.name}: {result.stderr.strip()}"
        )
    format_match = re.search(r"file format\s+(\S+)", result.stdout)
    file_format = format_match.group(1) if format_match else "unknown"
    if file_format.casefold() not in {"pei-x86-64", "coff-x86-64"}:
        raise ValueError(f"unexpected PE architecture for {binary.name}: {file_format}")
    imports = sorted(
        set(re.findall(r"DLL Name:\s*([^\r\n]+)", result.stdout)),
        key=str.casefold,
    )
    return imports, file_format


def main() -> None:
    args = parse_args()
    wheel = args.wheel.resolve(strict=True)
    objdump = args.objdump.resolve(strict=True)
    if wheel.name != EXPECTED_WHEEL_NAME:
        raise ValueError(f"unexpected wheel filename/tag: {wheel.name}")
    wheel_sha256 = hashlib.sha256(wheel.read_bytes()).hexdigest()

    with zipfile.ZipFile(wheel) as archive:
        members = checked_members(archive)
        names = [member.filename for member in members if not member.is_dir()]
        pyd_names = [name for name in names if PurePosixPath(name).suffix.casefold() == ".pyd"]
        if pyd_names != [EXPECTED_PYD]:
            raise ValueError(f"expected exactly one cv2 PE extension, got: {pyd_names}")
        if any(PurePosixPath(name).suffix.casefold() in {".a", ".lib", ".dll.a"} for name in names):
            raise ValueError("wheel contains a static or import library")
        metadata_name = f"{EXPECTED_DIST_INFO}/METADATA"
        wheel_metadata_name = f"{EXPECTED_DIST_INFO}/WHEEL"
        record_name = f"{EXPECTED_DIST_INFO}/RECORD"
        dist_info_roots = {
            PurePosixPath(name).parts[0]
            for name in names
            if PurePosixPath(name).parts[0].endswith(".dist-info")
        }
        if dist_info_roots != {EXPECTED_DIST_INFO}:
            raise ValueError(f"unexpected dist-info roots: {sorted(dist_info_roots)}")
        if metadata_name not in names or wheel_metadata_name not in names or record_name not in names:
            raise ValueError(f"wheel is missing custom distribution metadata: {metadata_name}")
        metadata = archive.read(metadata_name).decode("utf-8")
        if "Name: himmelcad-opencv-headless\n" not in metadata:
            raise ValueError("wheel uses an unexpected distribution identity")
        for required_metadata in (
            "Metadata-Version: 2.4\n",
            "Version: 4.13.0\n",
            "Requires-Python: >=3.12,<3.13\n",
        ):
            if required_metadata not in metadata:
                raise ValueError(f"wheel metadata is missing: {required_metadata.strip()}")
        if f"License-Expression: {EXPECTED_LICENSE_EXPRESSION}\n" not in metadata:
            raise ValueError("wheel metadata does not declare the audited SPDX closure")
        wheel_metadata = archive.read(wheel_metadata_name).decode("utf-8")
        if "Tag: cp312-cp312-win_amd64\n" not in wheel_metadata:
            raise ValueError("wheel metadata does not carry the audited ABI/platform tag")
        for suffix in REQUIRED_LICENSE_SUFFIXES:
            if f"{EXPECTED_DIST_INFO}/{suffix}" not in names:
                raise ValueError(f"wheel is missing required license: {suffix}")

        pe_names = [
            name for name in names if PurePosixPath(name).suffix.casefold() in PE_SUFFIXES
        ]
        packaged_by_basename: dict[str, str] = {}
        for name in pe_names:
            basename = PurePosixPath(name).name.casefold()
            if basename in packaged_by_basename:
                raise ValueError(f"duplicate packaged PE basename: {basename}")
            packaged_by_basename[basename] = name

        binaries: dict[str, dict[str, object]] = {}
        unresolved: dict[str, list[str]] = {}
        forbidden: dict[str, list[str]] = {}
        with tempfile.TemporaryDirectory(prefix="himmelcad-opencv-pe-audit-") as temp:
            temp_root = Path(temp)
            for index, name in enumerate(pe_names):
                destination = temp_root / f"{index}-{PurePosixPath(name).name}"
                destination.write_bytes(archive.read(name))
                imports, file_format = inspect_pe(objdump, destination)
                binaries[name] = {"format": file_format, "imports": imports}
                for imported in imports:
                    folded = imported.casefold()
                    if FORBIDDEN_IMPORT.search(folded):
                        forbidden.setdefault(name, []).append(imported)
                    if (
                        folded not in packaged_by_basename
                        and folded not in EXTERNAL_RUNTIME_DLLS
                        and not is_system_dll(folded)
                    ):
                        unresolved.setdefault(name, []).append(imported)

    if forbidden:
        raise ValueError(f"forbidden native imports: {forbidden}")
    if unresolved:
        raise ValueError(f"unresolved non-system native imports: {unresolved}")

    report = {
        "schemaVersion": 1,
        "wheel": wheel.name,
        "sha256": wheel_sha256,
        "architecture": "x86_64-windows",
        "externalRuntimeImports": sorted(EXTERNAL_RUNTIME_DLLS),
        "packagedPeFiles": binaries,
        "licenseFiles": sorted(
            name for name in names if ".dist-info/licenses/" in name
        ),
    }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()
