#!/usr/bin/env bash
set -euo pipefail

# Assemble the release Windows NumPy from the official MSVC extension modules
# and replace their stock OpenBLAS/GFortran payload with NumPy's own
# BSD-licensed ILP64 f2c BLAS/LAPACK implementation.  Nothing is published
# until an isolated NumPy + OpenCV runtime passes the real Windows smoke test.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${HIMMELCAD_NUMPY_BUILD_ROOT:-$ROOT/.build}"
LLVM_ROOT="${HIMMELCAD_LLVM_MINGW_ROOT:-$BUILD_ROOT/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64}"
PYTHON_ROOT="${HIMMELCAD_WINDOWS_PYTHON_ROOT:-$BUILD_ROOT/dedode-runtime/win32-x64/python}"
SOURCE_ARCHIVE="${HIMMELCAD_NUMPY_SOURCE_ARCHIVE:-$BUILD_ROOT/numpy-src/numpy-2.2.6.tar.gz}"
UPSTREAM_WHEEL="${HIMMELCAD_NUMPY_UPSTREAM_WHEEL:-$BUILD_ROOT/dedode-wheels-win/numpy-2.2.6-cp312-cp312-win_amd64.whl}"
OPENCV_WHEEL="${HIMMELCAD_OPENCV_WHEEL:-$BUILD_ROOT/automation-wheels/win32-x64/himmelcad_opencv_headless-4.13.0-cp312-cp312-win_amd64.whl}"
MSVC_RUNTIME_LICENSE="${HIMMELCAD_MSVC_RUNTIME_LICENSE:-$BUILD_ROOT/photolab-runtime/win32-x64/workers/dedode/python/LICENSE-Microsoft-VC-Runtime.rtf}"
CANDIDATE_WHEEL="${HIMMELCAD_NUMPY_CANDIDATE_WHEEL:-$BUILD_ROOT/automation-wheels/win32-x64/candidates/numpy-2.2.6-cp312-cp312-win_amd64.whl}"
SOURCE="$BUILD_ROOT/numpy-win-reference-src"
WHEEL_STAGE="$BUILD_ROOT/numpy-win-wheel-stage"
PROVIDER_BUILD="$BUILD_ROOT/numpy-win-reference-provider"
UNVERIFIED_WHEEL="$PROVIDER_BUILD/numpy-2.2.6-cp312-cp312-win_amd64.whl"
SMOKE_RUNTIME="$BUILD_ROOT/numpy-win-smoke-runtime"
WINE_EXECUTABLE="${HIMMELCAD_WINE_EXECUTABLE:-$BUILD_ROOT/wine-portable/wine-11.13-amd64-wow64/bin/wine}"
WINE_PREFIX="${HIMMELCAD_WINE_PREFIX:-$BUILD_ROOT/wine-prefix-headless}"
EXPECTED_SOURCE_SHA256="e29554e2bef54a90aa5cc07da6ce955accb83f21ab5de01a62c8478897b264fd"
EXPECTED_UPSTREAM_WHEEL_SHA256="c1f9540be57940698ed329904db803cf7a402f3fc200bfe599334c9bd84a40b2"
EXPECTED_MSVC_RUNTIME_LICENSE_SHA256="8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b"
PROVIDER_DLL_NAME="libscipy_openblas64_-13e2df515630b4a41f92893938845698.dll"

sha256_file() { sha256sum "$1" | cut -d' ' -f1; }
require_build_child() {
  local candidate root
  candidate="$(realpath -m "$1")"
  root="$(realpath "$BUILD_ROOT")"
  case "$candidate" in
    "$root"/*) ;;
    *) echo "Refusing to replace path outside the NumPy build root: $candidate" >&2; exit 1 ;;
  esac
  [[ "$candidate" != "$root" ]] || {
    echo "Refusing to replace the NumPy build root itself: $candidate" >&2
    exit 1
  }
}

[[ -f "$SOURCE_ARCHIVE" ]] || { echo "Missing pinned NumPy source: $SOURCE_ARCHIVE" >&2; exit 1; }
[[ "$(sha256_file "$SOURCE_ARCHIVE")" == "$EXPECTED_SOURCE_SHA256" ]] || {
  echo "NumPy source hash mismatch: $SOURCE_ARCHIVE" >&2
  exit 1
}
[[ -f "$UPSTREAM_WHEEL" ]] || { echo "Missing pinned upstream NumPy wheel: $UPSTREAM_WHEEL" >&2; exit 1; }
[[ "$(sha256_file "$UPSTREAM_WHEEL")" == "$EXPECTED_UPSTREAM_WHEEL_SHA256" ]] || {
  echo "Upstream NumPy wheel hash mismatch: $UPSTREAM_WHEEL" >&2
  exit 1
}
[[ -f "$OPENCV_WHEEL" ]] || { echo "Missing audited Windows OpenCV wheel: $OPENCV_WHEEL" >&2; exit 1; }
[[ -f "$MSVC_RUNTIME_LICENSE" ]] || { echo "Missing Microsoft VC Runtime license: $MSVC_RUNTIME_LICENSE" >&2; exit 1; }
[[ "$(sha256_file "$MSVC_RUNTIME_LICENSE")" == "$EXPECTED_MSVC_RUNTIME_LICENSE_SHA256" ]] || {
  echo "Microsoft VC Runtime license hash mismatch: $MSVC_RUNTIME_LICENSE" >&2
  exit 1
}
[[ -f "$PYTHON_ROOT/python.exe" && -d "$PYTHON_ROOT/include" ]] || {
  echo "Missing CPython 3.12 Windows runtime: $PYTHON_ROOT" >&2
  exit 1
}
[[ -x "$WINE_EXECUTABLE" ]] || { echo "Missing pinned Wine executable: $WINE_EXECUTABLE" >&2; exit 1; }

CC="$LLVM_ROOT/bin/x86_64-w64-mingw32-clang"
READOBJ="$LLVM_ROOT/bin/llvm-readobj"
[[ -x "$CC" && -x "$READOBJ" ]] || { echo "Missing pinned LLVM-MinGW tools: $LLVM_ROOT" >&2; exit 1; }

for path in "$SOURCE" "$WHEEL_STAGE" "$PROVIDER_BUILD" "$SMOKE_RUNTIME"; do
  require_build_child "$path"
done
rm -rf "$SOURCE" "$WHEEL_STAGE" "$PROVIDER_BUILD" "$SMOKE_RUNTIME"
mkdir -p "$SOURCE" "$WHEEL_STAGE" "$PROVIDER_BUILD"
tar -xzf "$SOURCE_ARCHIVE" --strip-components=1 -C "$SOURCE"
python3 -m zipfile -e "$UPSTREAM_WHEEL" "$WHEEL_STAGE"

LAPACK_LITE="$SOURCE/numpy/linalg/lapack_lite"
INCLUDE_ARGS=(
  "-I$LAPACK_LITE"
  "-I$SOURCE/numpy/_core/src/common"
  "-I$WHEEL_STAGE/numpy/_core/include"
  "-I$PYTHON_ROOT/include"
)
for source_name in \
  f2c.c f2c_config.c f2c_blas.c f2c_lapack.c \
  f2c_c_lapack.c f2c_d_lapack.c f2c_s_lapack.c f2c_z_lapack.c; do
  "$CC" -c -O2 -DHAVE_BLAS_ILP64 -DNPY_NO_DEPRECATED_API=NPY_2_0_API_VERSION \
    -Wno-parentheses "${INCLUDE_ARGS[@]}" "$LAPACK_LITE/$source_name" \
    -o "$PROVIDER_BUILD/${source_name%.c}.obj"
done
"$CC" -c -O2 "$ROOT/scripts/windows-numpy-reference-cblas.c" \
  -o "$PROVIDER_BUILD/reference-cblas.obj"

mapfile -t NUMPY_PYDS < <(find "$WHEEL_STAGE/numpy" -type f -name '*.pyd' -print | sort)
[[ "${#NUMPY_PYDS[@]}" -eq 19 ]] || {
  echo "Expected 19 upstream NumPy extension modules, found ${#NUMPY_PYDS[@]}" >&2
  exit 1
}
IMPORTED_SYMBOLS="$PROVIDER_BUILD/imported-symbols.txt"
for pyd in "${NUMPY_PYDS[@]}"; do
  "$READOBJ" --coff-imports "$pyd"
done | awk '/Symbol: scipy_/{print $2}' | sort -u > "$IMPORTED_SYMBOLS"
[[ "$(wc -l < "$IMPORTED_SYMBOLS")" -eq 57 ]] || {
  echo "Unexpected upstream NumPy BLAS/LAPACK symbol surface" >&2
  cat "$IMPORTED_SYMBOLS" >&2
  exit 1
}

PROVIDER_DEF="$PROVIDER_BUILD/provider.def"
{
  printf 'LIBRARY %s\nEXPORTS\n' "$PROVIDER_DLL_NAME"
  while read -r symbol; do
    if [[ "$symbol" == scipy_cblas_* ]]; then
      printf '  %s\n' "$symbol"
    else
      internal="${symbol#scipy_}"
      internal="${internal%64_}"
      printf '  %s=%s\n' "$symbol" "$internal"
    fi
  done < "$IMPORTED_SYMBOLS"
} > "$PROVIDER_DEF"

PROVIDER_DLL="$PROVIDER_BUILD/$PROVIDER_DLL_NAME"
"$CC" -shared -O2 -Wl,--no-insert-timestamp -o "$PROVIDER_DLL" \
  "$PROVIDER_BUILD"/*.obj "$PROVIDER_DEF"

PROVIDER_IMPORTS="$PROVIDER_BUILD/provider-imports.txt"
"$READOBJ" --coff-imports "$PROVIDER_DLL" |
  awk '$1 == "Name:" {print tolower($2)}' | sort -u > "$PROVIDER_IMPORTS"
if grep -Eiq 'gfortran|quadmath|gomp|iomp|openblas|blas|lapack|libgcc|libstdc\+\+' "$PROVIDER_IMPORTS"; then
  echo "Forbidden reference-provider runtime import:" >&2
  cat "$PROVIDER_IMPORTS" >&2
  exit 1
fi

PROVIDER_EXPORTS="$PROVIDER_BUILD/provider-exports.txt"
"$READOBJ" --coff-exports "$PROVIDER_DLL" |
  awk '$1 == "Name:" {print $2}' | sort -u > "$PROVIDER_EXPORTS"
MISSING_EXPORTS="$PROVIDER_BUILD/missing-exports.txt"
comm -23 "$IMPORTED_SYMBOLS" "$PROVIDER_EXPORTS" > "$MISSING_EXPORTS"
[[ ! -s "$MISSING_EXPORTS" ]] || {
  echo "Reference provider is missing required exports:" >&2
  cat "$MISSING_EXPORTS" >&2
  exit 1
}
EXTRA_EXPORTS="$PROVIDER_BUILD/extra-exports.txt"
comm -13 "$IMPORTED_SYMBOLS" "$PROVIDER_EXPORTS" > "$EXTRA_EXPORTS"
[[ ! -s "$EXTRA_EXPORTS" ]] || {
  echo "Reference provider exports symbols outside the pinned import surface:" >&2
  cat "$EXTRA_EXPORTS" >&2
  exit 1
}

mapfile -t STOCK_PROVIDERS < <(find "$WHEEL_STAGE/numpy.libs" -maxdepth 1 -type f -iname 'libscipy_openblas*.dll' -print)
[[ "${#STOCK_PROVIDERS[@]}" -eq 1 && "$(basename "${STOCK_PROVIDERS[0]}")" == "$PROVIDER_DLL_NAME" ]] || {
  echo "Unexpected upstream NumPy provider inventory" >&2
  printf '%s\n' "${STOCK_PROVIDERS[@]}" >&2
  exit 1
}
cp "$PROVIDER_DLL" "${STOCK_PROVIDERS[0]}"
cp "$ROOT/scripts/windows-numpy-runtime-config.py" "$WHEEL_STAGE/numpy/__config__.py"

DIST_INFO="$WHEEL_STAGE/numpy-2.2.6.dist-info"
rm -f "$DIST_INFO/DELVEWHEEL" "$DIST_INFO/RECORD" "$DIST_INFO/WHEEL"
rm -rf "$DIST_INFO/licenses"
mkdir -p \
  "$DIST_INFO/licenses/numpy" \
  "$DIST_INFO/licenses/lapack-lite" \
  "$DIST_INFO/licenses/libdivide" \
  "$DIST_INFO/licenses/numpy-random" \
  "$DIST_INFO/licenses/pocketfft" \
  "$DIST_INFO/licenses/pythoncapi-compat" \
  "$DIST_INFO/licenses/microsoft" \
  "$DIST_INFO/licenses/svml" \
  "$DIST_INFO/licenses/x86-simd-sort" \
  "$DIST_INFO/licenses/highway"
cp "$SOURCE/LICENSE.txt" "$DIST_INFO/licenses/numpy/LICENSE.txt"
cp "$SOURCE/LICENSES_bundled.txt" "$DIST_INFO/licenses/numpy/LICENSES_bundled.txt"
cp "$LAPACK_LITE/LICENSE.txt" "$DIST_INFO/licenses/lapack-lite/LICENSE.txt"
cp "$SOURCE/numpy/_core/include/numpy/libdivide/LICENSE.txt" "$DIST_INFO/licenses/libdivide/LICENSE.txt"
cp "$SOURCE/numpy/random/LICENSE.md" "$DIST_INFO/licenses/numpy-random/LICENSE.md"
cp "$SOURCE/numpy/fft/pocketfft/LICENSE.md" "$DIST_INFO/licenses/pocketfft/LICENSE.md"
cp "$SOURCE/numpy/_core/src/common/pythoncapi-compat/COPYING" "$DIST_INFO/licenses/pythoncapi-compat/COPYING"
cp "$MSVC_RUNTIME_LICENSE" "$DIST_INFO/licenses/microsoft/LICENSE-Microsoft-VC-Runtime.rtf"
cp "$SOURCE/numpy/_core/src/umath/svml/LICENSE" "$DIST_INFO/licenses/svml/LICENSE"
cp "$SOURCE/numpy/_core/src/npysort/x86-simd-sort/LICENSE.md" "$DIST_INFO/licenses/x86-simd-sort/LICENSE.md"
cp "$SOURCE/numpy/_core/src/highway/LICENSE" "$DIST_INFO/licenses/highway/LICENSE-Apache-2.0"
cp "$SOURCE/numpy/_core/src/highway/LICENSE-BSD3" "$DIST_INFO/licenses/highway/LICENSE-BSD-3-Clause"
sed -n '2,20p' "$SOURCE/numpy/_core/src/multiarray/dragon4.c" > "$DIST_INFO/licenses/numpy/dragon4-MIT.txt"
cp "$ROOT/scripts/windows-numpy-build-policy.json" "$DIST_INFO/HIMMELCAD_BUILD_POLICY.json"
WRAPPER_SHA256="$(sha256_file "$ROOT/scripts/windows-numpy-reference-cblas.c")"
CONFIG_SHA256="$(sha256_file "$ROOT/scripts/windows-numpy-runtime-config.py")"
SMOKE_SHA256="$(sha256_file "$ROOT/scripts/smoke-windows-automation-runtime.py")"
MSVCP_NAME="$(find "$WHEEL_STAGE/numpy.libs" -maxdepth 1 -type f -iname 'msvcp*.dll' -printf '%f\n')"
[[ -n "$MSVCP_NAME" ]] || { echo "Missing upstream MSVC C++ runtime payload" >&2; exit 1; }
MSVCP_SHA256="$(sha256_file "$WHEEL_STAGE/numpy.libs/$MSVCP_NAME")"
printf '%s\n' \
  '{' \
  '  "schema": 1,' \
  '  "component": "numpy-2.2.6-cp312-cp312-win_amd64",' \
  "  \"numpy_source\": {\"sha256\": \"$EXPECTED_SOURCE_SHA256\", \"url\": \"https://files.pythonhosted.org/packages/source/n/numpy/numpy-2.2.6.tar.gz\"}," \
  "  \"upstream_wheel\": {\"sha256\": \"$EXPECTED_UPSTREAM_WHEEL_SHA256\", \"origin\": \"PyPI official NumPy Windows wheel\"}," \
  "  \"provider\": {\"implementation\": \"NumPy lapack_lite f2c reference BLAS/LAPACK\", \"integer_abi\": \"ILP64\", \"compiler\": \"LLVM-MinGW clang 22.1.3, UCRT, 20260407\", \"cblas_bridge_sha256\": \"$WRAPPER_SHA256\"}," \
  "  \"runtime_config_sha256\": \"$CONFIG_SHA256\"," \
  "  \"dynamic_smoke_sha256\": \"$SMOKE_SHA256\"," \
  "  \"preserved_upstream_msvc_runtime\": {\"file\": \"$MSVCP_NAME\", \"sha256\": \"$MSVCP_SHA256\", \"license\": \"Microsoft redistributable terms (not an SPDX permissive license)\", \"license_file\": \"licenses/microsoft/LICENSE-Microsoft-VC-Runtime.rtf\", \"license_sha256\": \"$EXPECTED_MSVC_RUNTIME_LICENSE_SHA256\"}," \
  "  \"provider_pe_exports\": 57," \
  '  "provider_threads": 0' \
  '}' \
  > "$DIST_INFO/HIMMELCAD_PROVENANCE.json"
rm -f "$DIST_INFO/LICENSE.txt"
printf '%s\n' \
  'Metadata-Version: 2.4' \
  'Name: numpy' \
  'Version: 2.2.6' \
  'Summary: Fundamental package for array computing in Python' \
  'Requires-Python: >=3.10' \
  'License-Expression: BSD-3-Clause AND MIT AND Zlib AND Apache-2.0 AND 0BSD AND LicenseRef-Microsoft-Visual-Cpp-Runtime' \
  'License-File: licenses/numpy/LICENSE.txt' \
  'License-File: licenses/numpy/LICENSES_bundled.txt' \
  'License-File: licenses/numpy/dragon4-MIT.txt' \
  'License-File: licenses/lapack-lite/LICENSE.txt' \
  'License-File: licenses/libdivide/LICENSE.txt' \
  'License-File: licenses/numpy-random/LICENSE.md' \
  'License-File: licenses/pocketfft/LICENSE.md' \
  'License-File: licenses/pythoncapi-compat/COPYING' \
  'License-File: licenses/microsoft/LICENSE-Microsoft-VC-Runtime.rtf' \
  'License-File: licenses/svml/LICENSE' \
  'License-File: licenses/x86-simd-sort/LICENSE.md' \
  'License-File: licenses/highway/LICENSE-Apache-2.0' \
  'License-File: licenses/highway/LICENSE-BSD-3-Clause' \
  > "$DIST_INFO/METADATA"

if find "$WHEEL_STAGE" -type f \
    \( -iname '*gfortran*' -o -iname '*gomp*' -o -iname '*quadmath*' -o -iname '*libgcc*' -o -iname '*libstdc++*' \) \
    -print -quit | grep -q .; then
  echo "Forbidden GNU/Fortran/OpenMP payload remains in staged NumPy" >&2
  exit 1
fi
if grep -ERiq 'openblas|gfortran|gnu general public license|gcc runtime library|libgomp|libiomp' \
    "$DIST_INFO" "$WHEEL_STAGE/numpy/__config__.py"; then
  echo "Forbidden upstream provider or GPL/GCC metadata remains in staged NumPy" >&2
  exit 1
fi
if strings "$PROVIDER_DLL" | grep -Fivx "$PROVIDER_DLL_NAME" |
    grep -Eiq 'openblas|gfortran|gnu general public license|gcc runtime|libgomp|libiomp'; then
  echo "Forbidden implementation/runtime marker remains in reference provider" >&2
  exit 1
fi

python3 "$ROOT/scripts/package-staged-python-wheel.py" \
  --site-packages "$WHEEL_STAGE" \
  --package numpy \
  --package numpy.libs \
  --dist-info numpy-2.2.6.dist-info \
  --tag cp312-cp312-win_amd64 \
  --output "$UNVERIFIED_WHEEL"

# Build an isolated runtime.  In particular, never install the unverified
# candidate into the shared staged runtime under PYTHON_ROOT.
mkdir -p "$SMOKE_RUNTIME/Lib/site-packages"
while IFS= read -r -d '' entry; do
  cp -a "$entry" "$SMOKE_RUNTIME/"
done < <(find "$PYTHON_ROOT" -mindepth 1 -maxdepth 1 ! -name Lib -print0)
while IFS= read -r -d '' entry; do
  cp -a "$entry" "$SMOKE_RUNTIME/Lib/"
done < <(find "$PYTHON_ROOT/Lib" -mindepth 1 -maxdepth 1 ! -name site-packages -print0)
python3 -m zipfile -e "$UNVERIFIED_WHEEL" "$SMOKE_RUNTIME/Lib/site-packages"
python3 -m zipfile -e "$OPENCV_WHEEL" "$SMOKE_RUNTIME/Lib/site-packages"
python3 "$ROOT/scripts/smoke-windows-automation-runtime.py" \
  --python-root "$SMOKE_RUNTIME" \
  --wine-executable "$WINE_EXECUTABLE" \
  --wine-prefix "$WINE_PREFIX" \
  --timeout-seconds 120

mkdir -p "$(dirname "$CANDIDATE_WHEEL")"
mv "$UNVERIFIED_WHEEL" "$CANDIDATE_WHEEL"
WHEEL_SHA256="$(sha256_file "$CANDIDATE_WHEEL")"
echo "Windows NumPy 2.2.6 built: 19 official MSVC modules + audited ILP64 reference provider"
echo "Dynamic NumPy/OpenCV Wine smoke passed"
echo "Unpublished release candidate: $CANDIDATE_WHEEL ($WHEEL_SHA256)"
