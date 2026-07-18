#!/usr/bin/env bash
set -euo pipefail

# Cross-build the release NumPy used by the Windows DeDoDe worker. The stock
# wheel is deliberately rejected because its binary inventory incorporates a
# GNU Fortran runtime. This build has no BLAS/LAPACK dependency; descriptor
# matrix multiplication is executed by ONNX Runtime MLAS.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${HIMMELCAD_NUMPY_BUILD_ROOT:-$ROOT/.build}"
LLVM_ROOT="${HIMMELCAD_LLVM_MINGW_ROOT:-$BUILD_ROOT/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64}"
PYTHON_ROOT="${HIMMELCAD_WINDOWS_PYTHON_ROOT:-$BUILD_ROOT/dedode-runtime/win32-x64/python}"
ARCHIVE="${HIMMELCAD_NUMPY_SOURCE_ARCHIVE:-$BUILD_ROOT/numpy-src/numpy-2.2.6.tar.gz}"
SOURCE="$BUILD_ROOT/numpy-win-src"
BUILD="$BUILD_ROOT/numpy-win-build"
INSTALL="$BUILD_ROOT/numpy-win-install"
BUILD_VENV="$BUILD_ROOT/numpy-build"
CROSS_FILE="$BUILD_ROOT/numpy-win-cross.ini"
SITE_PACKAGES="$PYTHON_ROOT/Lib/site-packages"
EXPECTED_ARCHIVE_SHA256="e29554e2bef54a90aa5cc07da6ce955accb83f21ab5de01a62c8478897b264fd"

sha256_file() { sha256sum "$1" | cut -d' ' -f1; }
[[ -f "$ARCHIVE" ]] || { echo "Missing pinned NumPy source: $ARCHIVE" >&2; exit 1; }
[[ "$(sha256_file "$ARCHIVE")" == "$EXPECTED_ARCHIVE_SHA256" ]] || {
  echo "NumPy source hash mismatch: $ARCHIVE" >&2
  exit 1
}
[[ -f "$PYTHON_ROOT/python312.dll" && -d "$PYTHON_ROOT/include" ]] || {
  echo "Missing CPython 3.12 Windows runtime: $PYTHON_ROOT" >&2
  exit 1
}
[[ -x "$LLVM_ROOT/bin/x86_64-w64-mingw32-clang" ]] || {
  echo "Missing pinned LLVM-MinGW toolchain: $LLVM_ROOT" >&2
  exit 1
}
command -v ninja >/dev/null

if [[ ! -x "$BUILD_VENV/bin/cython" ]]; then
  python3 -m venv "$BUILD_VENV"
  "$BUILD_VENV/bin/python" -m pip install --disable-pip-version-check "Cython==3.2.8"
fi

rm -rf "$SOURCE" "$BUILD" "$INSTALL"
mkdir -p "$SOURCE" "$PYTHON_ROOT/libs"
tar -xzf "$ARCHIVE" --strip-components=1 -C "$SOURCE"

READOBJ="$LLVM_ROOT/bin/llvm-readobj"
DLLTOOL="$LLVM_ROOT/bin/llvm-dlltool"
{
  echo "LIBRARY python312.dll"
  echo "EXPORTS"
  "$READOBJ" --coff-exports "$PYTHON_ROOT/python312.dll" |
    awk '$1 == "Name:" { print "  " $2 }'
} > "$PYTHON_ROOT/libs/python312.def"
"$DLLTOOL" -d "$PYTHON_ROOT/libs/python312.def" -l "$PYTHON_ROOT/libs/libpython312.a"

cat > "$CROSS_FILE" <<EOF
[binaries]
c = '$LLVM_ROOT/bin/x86_64-w64-mingw32-clang'
cpp = '$LLVM_ROOT/bin/x86_64-w64-mingw32-clang++'
ar = '$LLVM_ROOT/bin/llvm-ar'
strip = '$LLVM_ROOT/bin/llvm-strip'
windres = '$LLVM_ROOT/bin/x86_64-w64-mingw32-windres'
python = '/usr/bin/python3'

[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'

[properties]
needs_exe_wrapper = true
longdouble_format = 'IEEE_DOUBLE_LE'

[built-in options]
c_args = ['-I$PYTHON_ROOT/include', '-mlong-double-64']
c_link_args = ['-L$PYTHON_ROOT/libs', '-lpython312']
EOF

export PATH="$BUILD_VENV/bin:$PATH"
MESON=("$BUILD_VENV/bin/python" "$SOURCE/vendored-meson/meson/meson.py")
"${MESON[@]}" setup "$BUILD" "$SOURCE" \
  --cross-file="$CROSS_FILE" \
  -Dbuildtype=release \
  -Dblas=none \
  -Dlapack=none
"${MESON[@]}" compile -C "$BUILD"
DESTDIR="$INSTALL" "${MESON[@]}" install -C "$BUILD" --no-rebuild

rm -rf "$SITE_PACKAGES/numpy" "$SITE_PACKAGES/numpy-2.2.6.dist-info" "$SITE_PACKAGES/numpy.libs"
cp -a "$INSTALL/usr/local/lib/python3/dist-packages/numpy" "$SITE_PACKAGES/numpy"
while IFS= read -r -d '' file; do
  mv "$file" "${file%.cpython-312-x86_64-linux-gnu.so}.pyd"
done < <(find "$SITE_PACKAGES/numpy" -type f -name '*.cpython-312-x86_64-linux-gnu.so' -print0)
find "$SITE_PACKAGES/numpy" -type d \
  \( -name tests -o -name _pyinstaller -o -name f2py -o -name typing \) \
  -prune -exec rm -rf {} +
find "$SITE_PACKAGES/numpy" -type f \
  \( -name '*.a' -o -name '*.dll.a' -o -name '*.h' -o -name '*.pxd' -o -name '*.pyi' -o -name '*.pyc' \) \
  -delete

mkdir -p "$SITE_PACKAGES/numpy-2.2.6.dist-info/licenses/numpy"
cp "$SOURCE/LICENSE.txt" "$SITE_PACKAGES/numpy-2.2.6.dist-info/licenses/numpy/LICENSE.txt"
printf '%s\n' \
  'Metadata-Version: 2.1' \
  'Name: numpy' \
  'Version: 2.2.6' \
  'License-Expression: BSD-3-Clause' \
  'License-File: licenses/numpy/LICENSE.txt' \
  > "$SITE_PACKAGES/numpy-2.2.6.dist-info/METADATA"
printf '%s\n' 'numpy' > "$SITE_PACKAGES/numpy-2.2.6.dist-info/top_level.txt"

PYD_COUNT="$(find "$SITE_PACKAGES/numpy" -type f -name '*.pyd' | wc -l)"
[[ "$PYD_COUNT" -eq 19 ]] || { echo "Expected 19 NumPy extension modules, found $PYD_COUNT" >&2; exit 1; }
IMPORTS="$BUILD_ROOT/numpy-win-imports.txt"
find "$SITE_PACKAGES/numpy" -type f -name '*.pyd' -print0 |
  xargs -0 -n1 "$LLVM_ROOT/bin/llvm-objdump" -p |
  sed -n 's/.*DLL Name: //p' | sort -fu > "$IMPORTS"
if grep -Eiq 'gomp|gfortran|quadmath|iomp|openblas|blas|lapack' "$IMPORTS"; then
  echo "Forbidden NumPy runtime import:" >&2
  cat "$IMPORTS" >&2
  exit 1
fi
echo "Windows NumPy 2.2.6 runtime built: $PYD_COUNT PE modules, no BLAS/Fortran/OpenMP imports"
