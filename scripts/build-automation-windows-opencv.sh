#!/usr/bin/env bash
set -euo pipefail

# Reproducible, headless OpenCV 4.13.0 cross-build for the managed Windows
# CPython 3.12 automation runtime. This script intentionally does not stage or
# mutate a runtime manifest; it only emits an audited wheel and audit reports.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SANDBOX="$(realpath -e "$ROOT/.build")"
BUILD_ROOT="${HIMMELCAD_OPENCV_BUILD_ROOT:-$ROOT/.build/opencv-win-cp312}"
BUILD_ROOT="$(realpath -m "$BUILD_ROOT")"
LLVM_ROOT="${HIMMELCAD_LLVM_MINGW_ROOT:-$ROOT/.build/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64}"
PYTHON_ROOT="${HIMMELCAD_WINDOWS_PYTHON_ROOT:-$ROOT/.build/dedode-runtime/win32-x64/python}"
NUMPY_INCLUDE="${HIMMELCAD_WINDOWS_NUMPY_INCLUDE:-$ROOT/.build/numpy-win-install/usr/local/lib/python3/dist-packages/numpy/_core/include}"
SOURCE_ARCHIVE="${HIMMELCAD_OPENCV_SOURCE_ARCHIVE:-$ROOT/.build/opencv-src/opencv-4.13.0.tar.gz}"
SOURCE="$BUILD_ROOT/source"
BUILD="$BUILD_ROOT/build"
INSTALL="$BUILD_ROOT/install"
PYTHON_LIB_ROOT="$BUILD_ROOT/python-libs"
SITE_PACKAGES="$INSTALL/site-packages"
OUTPUT_WHEEL="${HIMMELCAD_OPENCV_OUTPUT_WHEEL:-$ROOT/.build/automation-wheels/win32-x64/himmelcad_opencv_headless-4.13.0-cp312-cp312-win_amd64.whl}"
AUDIT_REPORT="${HIMMELCAD_OPENCV_AUDIT_REPORT:-$BUILD_ROOT/windows-opencv-wheel-audit.json}"
BUILD_PROFILE="$BUILD_ROOT/windows-opencv-build-profile.txt"
OPENCV_URL="https://github.com/opencv/opencv/archive/refs/tags/4.13.0.tar.gz"
OPENCV_SHA256="1d40ca017ea51c533cf9fd5cbde5b5fe7ae248291ddf2af99d4c17cf8e13017d"
PYTHON_DLL_SHA256="f6ad19fa4d285626f583224699211cdbb28eae9d0fb5415bde94a117543105b7"
PYTHON_HEADERS_SHA256="eff68cb478cd98d9adf02037761384da743d7e07a1058fb9eb353ead3e0bd0a8"
NUMPY_HEADERS_SHA256="09b9cae85d00a47afb9858af04cfaa64ae5b3be9db9582de43e725606df2672d"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1767225600}"
export SOURCE_DATE_EPOCH ZERO_AR_DATE=1 PYTHONHASHSEED=0 LC_ALL=C TZ=UTC

sha256_file() { sha256sum "$1" | cut -d' ' -f1; }
sha256_tree() {
  (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
}
fail() { echo "$*" >&2; exit 1; }

case "$BUILD_ROOT" in
  "$BUILD_SANDBOX"/*) ;;
  *) fail "OpenCV build root must remain below $BUILD_SANDBOX: $BUILD_ROOT" ;;
esac
case "$(basename "$BUILD_ROOT")" in
  *opencv*) ;;
  *) fail "OpenCV build root basename must contain 'opencv': $BUILD_ROOT" ;;
esac

for command in cmake curl python3 realpath sha256sum tar; do
  command -v "$command" >/dev/null || fail "Required command is missing: $command"
done
[[ -x "$LLVM_ROOT/bin/x86_64-w64-mingw32-clang++" ]] || \
  fail "Pinned LLVM-MinGW toolchain is missing: $LLVM_ROOT"
[[ -x "$LLVM_ROOT/bin/llvm-objdump" ]] || fail "llvm-objdump is missing: $LLVM_ROOT"
[[ -f "$PYTHON_ROOT/python312.dll" && -d "$PYTHON_ROOT/include" ]] || \
  fail "Managed CPython 3.12 Windows runtime is missing: $PYTHON_ROOT"
[[ -f "$NUMPY_INCLUDE/numpy/arrayobject.h" ]] || \
  fail "Cross-built NumPy headers are missing: $NUMPY_INCLUDE"
[[ "$(sha256_file "$PYTHON_ROOT/python312.dll")" == "$PYTHON_DLL_SHA256" ]] || \
  fail "CPython 3.12 Windows DLL hash mismatch: $PYTHON_ROOT/python312.dll"
[[ "$(sha256_tree "$PYTHON_ROOT/include")" == "$PYTHON_HEADERS_SHA256" ]] || \
  fail "CPython 3.12 Windows header inventory hash mismatch: $PYTHON_ROOT/include"
[[ "$(sha256_tree "$NUMPY_INCLUDE")" == "$NUMPY_HEADERS_SHA256" ]] || \
  fail "NumPy Windows header inventory hash mismatch: $NUMPY_INCLUDE"
"$LLVM_ROOT/bin/x86_64-w64-mingw32-clang++" --version | \
  grep -q '^clang version 22\.1\.3 ' || fail "Unexpected LLVM-MinGW compiler version"

NINJA="${HIMMELCAD_NINJA:-}"
if [[ -z "$NINJA" ]]; then
  NINJA="$(command -v ninja || true)"
fi
if [[ -z "$NINJA" ]]; then
  NINJA="$(find "$ROOT/.build/colmap-worker/vcpkg/downloads/tools" -type f -name ninja -perm -u+x 2>/dev/null | sort | head -n 1)"
fi
[[ -n "$NINJA" && -x "$NINJA" ]] || fail "Ninja is missing; set HIMMELCAD_NINJA"

mkdir -p "$(dirname "$SOURCE_ARCHIVE")" "$BUILD_ROOT" "$PYTHON_LIB_ROOT"
if [[ ! -f "$SOURCE_ARCHIVE" ]]; then
  curl -fL --retry 3 "$OPENCV_URL" -o "$SOURCE_ARCHIVE"
fi
[[ "$(sha256_file "$SOURCE_ARCHIVE")" == "$OPENCV_SHA256" ]] || \
  fail "OpenCV 4.13.0 source hash mismatch: $SOURCE_ARCHIVE"

# These are fixed children of a guarded repository .build path. Keeping the
# source tree fresh prevents stale CMake state from changing the output.
rm -rf "$SOURCE" "$BUILD" "$INSTALL" "$PYTHON_LIB_ROOT"
mkdir -p "$SOURCE" "$BUILD" "$INSTALL" "$PYTHON_LIB_ROOT"
tar -xzf "$SOURCE_ARCHIVE" --strip-components=1 -C "$SOURCE"

{
  echo "LIBRARY python312.dll"
  echo "EXPORTS"
  "$LLVM_ROOT/bin/llvm-readobj" --coff-exports "$PYTHON_ROOT/python312.dll" |
    awk '$1 == "Name:" { print "  " $2 }'
} > "$PYTHON_LIB_ROOT/python312.def"
"$LLVM_ROOT/bin/llvm-dlltool" \
  -d "$PYTHON_LIB_ROOT/python312.def" \
  -l "$PYTHON_LIB_ROOT/libpython312.a"

COMMON_PREFIX_MAP="-ffile-prefix-map=$SOURCE=/usr/src/opencv-4.13.0 -ffile-prefix-map=$BUILD=/usr/src/opencv-build"
cmake -S "$SOURCE" -B "$BUILD" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$NINJA" \
  -DCMAKE_SYSTEM_NAME=Windows \
  -DCMAKE_SYSTEM_PROCESSOR=x86_64 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$INSTALL" \
  -DCMAKE_C_COMPILER="$LLVM_ROOT/bin/x86_64-w64-mingw32-clang" \
  -DCMAKE_CXX_COMPILER="$LLVM_ROOT/bin/x86_64-w64-mingw32-clang++" \
  -DCMAKE_RC_COMPILER="$LLVM_ROOT/bin/x86_64-w64-mingw32-windres" \
  -DCMAKE_AR="$LLVM_ROOT/bin/llvm-ar" \
  -DCMAKE_RANLIB="$LLVM_ROOT/bin/llvm-ranlib" \
  -DCMAKE_STRIP="$LLVM_ROOT/bin/llvm-strip" \
  -DCMAKE_FIND_ROOT_PATH="$LLVM_ROOT/x86_64-w64-mingw32" \
  -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG $COMMON_PREFIX_MAP" \
  -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG $COMMON_PREFIX_MAP" \
  -DCMAKE_EXE_LINKER_FLAGS="-static" \
  -DCMAKE_SHARED_LINKER_FLAGS="-static" \
  -DCMAKE_MODULE_LINKER_FLAGS="-static" \
  -DBUILD_LIST=core,imgproc,imgcodecs,calib3d,features2d,flann,photo,video,python3 \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_opencv_apps=OFF \
  -DBUILD_opencv_dnn=OFF \
  -DBUILD_opencv_highgui=OFF \
  -DBUILD_opencv_videoio=OFF \
  -DBUILD_opencv_world=OFF \
  -DBUILD_opencv_java=OFF \
  -DBUILD_opencv_js=OFF \
  -DBUILD_opencv_python2=OFF \
  -DBUILD_TESTS=OFF \
  -DBUILD_PERF_TESTS=OFF \
  -DBUILD_EXAMPLES=OFF \
  -DBUILD_DOCS=OFF \
  -DINSTALL_TESTS=OFF \
  -DINSTALL_C_EXAMPLES=OFF \
  -DINSTALL_PYTHON_EXAMPLES=OFF \
  -DOPENCV_FORCE_3RDPARTY_BUILD=ON \
  -DBUILD_ZLIB=ON \
  -DBUILD_JPEG=ON \
  -DBUILD_PNG=ON \
  -DBUILD_TIFF=ON \
  -DBUILD_WEBP=ON \
  -DBUILD_OPENJPEG=OFF \
  -DWITH_JPEG=ON \
  -DWITH_PNG=ON \
  -DWITH_TIFF=ON \
  -DWITH_WEBP=ON \
  -DWITH_OPENJPEG=OFF \
  -DWITH_JASPER=OFF \
  -DWITH_OPENEXR=OFF \
  -DWITH_GDAL=OFF \
  -DWITH_GDCM=OFF \
  -DWITH_FFMPEG=OFF \
  -DWITH_GSTREAMER=OFF \
  -DWITH_MSMF=OFF \
  -DWITH_DSHOW=OFF \
  -DWITH_VFW=OFF \
  -DWITH_1394=OFF \
  -DWITH_LAPACK=OFF \
  -DWITH_EIGEN=OFF \
  -DWITH_OPENMP=OFF \
  -DWITH_TBB=OFF \
  -DWITH_PTHREADS_PF=OFF \
  -DWITH_IPP=OFF \
  -DWITH_ITT=OFF \
  -DWITH_OPENCL=OFF \
  -DWITH_OPENCL_SVM=OFF \
  -DWITH_OPENGL=OFF \
  -DWITH_VULKAN=OFF \
  -DWITH_DIRECTX=OFF \
  -DWITH_QT=OFF \
  -DWITH_GTK=OFF \
  -DWITH_WIN32UI=OFF \
  -DWITH_VTK=OFF \
  -DWITH_CUDA=OFF \
  -DWITH_CUBLAS=OFF \
  -DWITH_CUDNN=OFF \
  -DWITH_PROTOBUF=OFF \
  -DWITH_FLATBUFFERS=OFF \
  -DWITH_ADE=OFF \
  -DGENERATE_PYTHON_STUBS=OFF \
  -DPYTHON_DEFAULT_EXECUTABLE=/usr/bin/python3 \
  -DPYTHON3_EXECUTABLE=/usr/bin/python3 \
  -DPYTHON3_VERSION_STRING=3.12.0 \
  -DPYTHON3_VERSION_MAJOR=3 \
  -DPYTHON3_VERSION_MINOR=12 \
  -DPYTHON3_INCLUDE_PATH="$PYTHON_ROOT/include" \
  -DPYTHON3_INCLUDE_DIR="$PYTHON_ROOT/include" \
  -DPYTHON3_LIBRARY="$PYTHON_LIB_ROOT/libpython312.a" \
  -DPYTHON3_LIBRARIES="$PYTHON_LIB_ROOT/libpython312.a" \
  -DPYTHON3_NUMPY_INCLUDE_DIRS="$NUMPY_INCLUDE" \
  -DPYTHON3_NUMPY_VERSION=2.2.6 \
  -DPYTHON3_PACKAGES_PATH=site-packages \
  -DOPENCV_PYTHON3_INSTALL_PATH=site-packages \
  -DPYTHON3_CVPY_SUFFIX=.cp312-win_amd64.pyd \
  -DPYTHON3_LIMITED_API=OFF

for option in \
  BUILD_SHARED_LIBS BUILD_opencv_dnn BUILD_opencv_highgui BUILD_opencv_videoio \
  WITH_FFMPEG WITH_GSTREAMER WITH_LAPACK WITH_OPENMP WITH_IPP WITH_OPENCL \
  WITH_OPENGL WITH_QT WITH_GTK WITH_WIN32UI WITH_CUDA WITH_PROTOBUF \
  WITH_FLATBUFFERS; do
  grep -Eq "^${option}:[^=]+=OFF$" "$BUILD/CMakeCache.txt" || \
    fail "CMake did not preserve the audited OFF setting: $option"
done

MODULE_HEADER="$BUILD/opencv2/opencv_modules.hpp"
[[ -f "$MODULE_HEADER" ]] || fail "Generated OpenCV module inventory is missing"
ACTUAL_MODULES="$(sed -n 's/^#define HAVE_OPENCV_\([A-Za-z0-9_]*\)$/\1/p' "$MODULE_HEADER" | tr '[:upper:]' '[:lower:]' | sort -u | paste -sd, -)"
EXPECTED_MODULES="calib3d,core,features2d,flann,imgcodecs,imgproc,photo,video"
[[ "$ACTUAL_MODULES" == "$EXPECTED_MODULES" ]] || \
  fail "Unexpected native OpenCV module set: $ACTUAL_MODULES"

# Upstream's getBuildInformation() payload contains absolute compiler, build,
# install and dependency paths. Replace only that generated payload with a
# stable and still diagnostic profile before core is compiled.
cat > "$BUILD/version_string.tmp" <<'EOF'
"\n"
"General configuration for OpenCV 4.13.0 (HimmelCAD Windows headless)\n"
"  Target: Windows x86_64\n"
"  Toolchain: LLVM-MinGW 20260407 UCRT\n"
"  Modules: calib3d core features2d flann imgcodecs imgproc photo video\n"
"  Codecs: bundled JPEG PNG TIFF WebP zlib\n"
"  Dynamic features: videoio=OFF dnn=OFF gui=OFF OpenCL=OFF IPP=OFF\n"
"  Math runtimes: BLAS=OFF LAPACK=OFF OpenMP=OFF\n"
"  Python ABI: CPython 3.12 win_amd64\n"
EOF
cp "$BUILD/version_string.tmp" "$BUILD/modules/core/version_string.inc"
cat > "$BUILD/opencv_data_config.hpp" <<'EOF'
#define OPENCV_INSTALL_PREFIX "C:/himmelcad/opencv"
#define OPENCV_DATA_INSTALL_PATH "share/opencv4"
#define OPENCV_BUILD_DIR "C:/himmelcad/opencv-build"
#define OPENCV_DATA_BUILD_DIR_SEARCH_PATHS "../source/"
#define OPENCV_INSTALL_DATA_DIR_RELATIVE "../share/opencv4"
EOF

BUILD_JOBS="${HIMMELCAD_BUILD_JOBS:-4}"
cmake --build "$BUILD" --target opencv_python3 --parallel "$BUILD_JOBS"
cmake --install "$BUILD" --component python

mapfile -d '' PYD_FILES < <(find "$SITE_PACKAGES/cv2" -type f -name '*.pyd' -print0)
[[ "${#PYD_FILES[@]}" -eq 1 ]] || \
  fail "Expected one cv2 extension in the install tree, found ${#PYD_FILES[@]}"
"$LLVM_ROOT/bin/llvm-strip" --strip-debug "${PYD_FILES[0]}"

DIST_INFO="$SITE_PACKAGES/himmelcad_opencv_headless-4.13.0.dist-info"
LICENSE_ROOT="$DIST_INFO/licenses"
mkdir -p \
  "$LICENSE_ROOT/opencv" \
  "$LICENSE_ROOT/libjpeg-turbo" \
  "$LICENSE_ROOT/libpng" \
  "$LICENSE_ROOT/libtiff" \
  "$LICENSE_ROOT/libwebp" \
  "$LICENSE_ROOT/zlib" \
  "$LICENSE_ROOT/dlpack" \
  "$LICENSE_ROOT/softfloat" \
  "$LICENSE_ROOT/llvm" \
  "$LICENSE_ROOT/mingw-w64"
cp "$SOURCE/LICENSE" "$LICENSE_ROOT/opencv/LICENSE"
cp "$SOURCE/3rdparty/libjpeg-turbo/LICENSE.md" "$LICENSE_ROOT/libjpeg-turbo/LICENSE.md"
cp "$SOURCE/3rdparty/libjpeg-turbo/README.ijg" "$LICENSE_ROOT/libjpeg-turbo/README.ijg"
cp "$SOURCE/3rdparty/libpng/LICENSE" "$LICENSE_ROOT/libpng/LICENSE"
cp "$SOURCE/3rdparty/libtiff/LICENSE.md" "$LICENSE_ROOT/libtiff/LICENSE.md"
cp "$SOURCE/3rdparty/libwebp/COPYING" "$LICENSE_ROOT/libwebp/COPYING"
cp "$SOURCE/3rdparty/zlib/LICENSE" "$LICENSE_ROOT/zlib/LICENSE"
cp "$SOURCE/3rdparty/dlpack/LICENSE" "$LICENSE_ROOT/dlpack/LICENSE"
cp "$SOURCE/modules/core/3rdparty/SoftFloat/COPYING.txt" \
  "$LICENSE_ROOT/softfloat/COPYING.txt"
cp "$LLVM_ROOT/LICENSE.TXT" "$LICENSE_ROOT/llvm/LICENSE.TXT"
cp "$LLVM_ROOT/x86_64-w64-mingw32/share/mingw32/COPYING.MinGW-w64-runtime.txt" \
  "$LICENSE_ROOT/mingw-w64/COPYING.MinGW-w64-runtime.txt"
cp "$LLVM_ROOT/x86_64-w64-mingw32/share/mingw32/COPYING.winpthreads.txt" \
  "$LICENSE_ROOT/mingw-w64/COPYING.winpthreads.txt"
printf '%s\n' \
  'Metadata-Version: 2.4' \
  'Name: himmelcad-opencv-headless' \
  'Version: 4.13.0' \
  'Summary: HimmelCAD audited headless OpenCV runtime' \
  'License-Expression: Apache-2.0 AND (Apache-2.0 WITH LLVM-exception) AND BSD-2-Clause AND BSD-3-Clause AND HPND AND IJG AND ISC AND LicenseRef-Cephes-MinGW-w64 AND MIT AND SunPro AND ZPL-2.1 AND Zlib AND libpng-2.0 AND libtiff' \
  'License-File: licenses/opencv/LICENSE' \
  'License-File: licenses/libjpeg-turbo/LICENSE.md' \
  'License-File: licenses/libjpeg-turbo/README.ijg' \
  'License-File: licenses/libpng/LICENSE' \
  'License-File: licenses/libtiff/LICENSE.md' \
  'License-File: licenses/libwebp/COPYING' \
  'License-File: licenses/zlib/LICENSE' \
  'License-File: licenses/dlpack/LICENSE' \
  'License-File: licenses/softfloat/COPYING.txt' \
  'License-File: licenses/llvm/LICENSE.TXT' \
  'License-File: licenses/mingw-w64/COPYING.MinGW-w64-runtime.txt' \
  'License-File: licenses/mingw-w64/COPYING.winpthreads.txt' \
  'Requires-Python: >=3.12,<3.13' \
  'Requires-Dist: numpy>=1.26' \
  > "$DIST_INFO/METADATA"
printf '%s\n' 'cv2' > "$DIST_INFO/top_level.txt"

python3 "$ROOT/scripts/package-staged-python-wheel.py" \
  --site-packages "$SITE_PACKAGES" \
  --package cv2 \
  --dist-info "$(basename "$DIST_INFO")" \
  --tag cp312-cp312-win_amd64 \
  --output "$OUTPUT_WHEEL"

python3 "$ROOT/scripts/verification/audit-windows-opencv-wheel.py" \
  --wheel "$OUTPUT_WHEEL" \
  --objdump "$LLVM_ROOT/bin/llvm-objdump" \
  --report "$AUDIT_REPORT" >/dev/null

{
  echo "opencv_source_sha256=$OPENCV_SHA256"
  echo "wheel_sha256=$(sha256_file "$OUTPUT_WHEEL")"
  echo "modules=$EXPECTED_MODULES"
  echo "python_abi=cp312-cp312-win_amd64"
  echo "build_shared_libs=OFF"
  echo "videoio=OFF"
  echo "ffmpeg=OFF"
  echo "gstreamer=OFF"
  echo "blas_lapack_fortran_openmp=OFF"
  echo "ipp_opencl_gui_dnn=OFF"
  echo "audit_report=$AUDIT_REPORT"
} > "$BUILD_PROFILE"

echo "Windows HimmelCAD OpenCV 4.13.0 headless wheel: $OUTPUT_WHEEL"
echo "SHA-256: $(sha256_file "$OUTPUT_WHEEL")"
echo "Static PE audit: $AUDIT_REPORT"
