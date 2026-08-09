#!/usr/bin/env bash
set -euo pipefail

# Builds the release OpenCV Python module against a glibc 2.28 baseline.
# Zig supplies the pinned libc/libc++ sysroot, so the result does not inherit
# the build host's glibc or libstdc++ baseline. All image codecs are statically
# linked from the OpenCV source archive; video/network/GUI/DNN backends stay out.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$ROOT/.build"
SOURCE_ARCHIVE="$BUILD_ROOT/opencv-src/opencv-4.13.0.tar.gz"
SOURCE_ROOT="$BUILD_ROOT/opencv-src/opencv-4.13.0"
ZIG_ARCHIVE="$BUILD_ROOT/zig/zig-x86_64-linux-0.14.1.tar.xz"
ZIG_ROOT="$BUILD_ROOT/zig/zig-x86_64-linux-0.14.1"
BUILD="$BUILD_ROOT/opencv-linux-zig-build"
INSTALL="$BUILD_ROOT/opencv-linux-zig-install"
STAGE="$BUILD_ROOT/opencv-linux-wheel-stage"
RUNTIME="$BUILD_ROOT/automation-runtime/linux-x64/python"
OUTPUT="$BUILD_ROOT/automation-wheels/linux-x64/himmelcad_opencv_headless-4.13.0-cp312-cp312-manylinux_2_28_x86_64.whl"
SOURCE_SHA256="1d40ca017ea51c533cf9fd5cbde5b5fe7ae248291ddf2af99d4c17cf8e13017d"
ZIG_SHA256="24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c"
DIST_INFO="himmelcad_opencv_headless-4.13.0.dist-info"

export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export SOURCE_DATE_EPOCH=1767225600

sha256_file() { sha256sum "$1" | cut -d' ' -f1; }
require_hash() {
  local path="$1" expected="$2"
  [[ -f "$path" && "$(sha256_file "$path")" == "$expected" ]] || {
    echo "Pinned build input is missing or has the wrong hash: $path" >&2
    exit 1
  }
}

require_hash "$SOURCE_ARCHIVE" "$SOURCE_SHA256"
require_hash "$ZIG_ARCHIVE" "$ZIG_SHA256"
[[ -x "$RUNTIME/bin/python3" ]] || { echo "Staged CPython 3.12 runtime is missing" >&2; exit 1; }
[[ -d "$RUNTIME/lib/python3.12/site-packages/numpy/_core/include" ]] || {
  echo "Staged no-BLAS NumPy headers are missing" >&2
  exit 1
}

if [[ ! -f "$SOURCE_ROOT/CMakeLists.txt" ]]; then
  mkdir -p "$(dirname "$SOURCE_ROOT")"
  tar -xzf "$SOURCE_ARCHIVE" -C "$(dirname "$SOURCE_ROOT")"
fi
if [[ ! -x "$ZIG_ROOT/zig" ]]; then
  mkdir -p "$(dirname "$ZIG_ROOT")"
  tar -xJf "$ZIG_ARCHIVE" -C "$(dirname "$ZIG_ROOT")"
fi

cmake -S "$SOURCE_ROOT" -B "$BUILD" -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$INSTALL" \
  -DCMAKE_C_COMPILER="$ZIG_ROOT/zig" \
  -DCMAKE_C_COMPILER_ARG1=cc \
  -DCMAKE_CXX_COMPILER="$ZIG_ROOT/zig" \
  -DCMAKE_CXX_COMPILER_ARG1=c++ \
  -DCMAKE_C_FLAGS="-target x86_64-linux-gnu.2.28" \
  -DCMAKE_CXX_FLAGS="-target x86_64-linux-gnu.2.28" \
  -DBUILD_LIST=core,imgproc,imgcodecs,calib3d,features2d,flann,photo,video,python3 \
  -DBUILD_SHARED_LIBS=OFF \
  -DOPENCV_FORCE_3RDPARTY_BUILD=ON \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_DOCS=OFF \
  -DBUILD_JAVA=OFF -DBUILD_opencv_apps=OFF -DBUILD_opencv_js=OFF \
  -DBUILD_opencv_python2=OFF -DBUILD_opencv_python3=ON \
  -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_V4L=OFF -DWITH_1394=OFF \
  -DWITH_OPENCL=OFF -DWITH_OPENGL=OFF -DWITH_GTK=OFF -DWITH_QT=OFF \
  -DWITH_LAPACK=OFF -DWITH_OPENBLAS=OFF -DWITH_EIGEN=OFF \
  -DWITH_TBB=OFF -DWITH_OPENMP=OFF -DWITH_IPP=OFF -DBUILD_IPP_IW=OFF \
  -DWITH_ITT=OFF -DWITH_ADE=OFF -DWITH_OPENEXR=OFF -DWITH_JASPER=OFF \
  -DWITH_OPENJPEG=ON -DBUILD_OPENJPEG=ON -DWITH_WEBP=ON -DBUILD_WEBP=ON \
  -DBUILD_JPEG=ON -DBUILD_PNG=ON -DBUILD_TIFF=ON -DBUILD_ZLIB=ON \
  -DPYTHON3_EXECUTABLE="$RUNTIME/bin/python3" \
  -DPYTHON3_INCLUDE_DIR="$RUNTIME/include/python3.12" \
  -DPYTHON3_LIBRARY="$RUNTIME/lib/libpython3.12.so.1.0" \
  -DPYTHON3_NUMPY_INCLUDE_DIRS="$RUNTIME/lib/python3.12/site-packages/numpy/_core/include" \
  -DPYTHON3_PACKAGES_PATH="$INSTALL/site-packages" \
  -DOPENCV_SKIP_PYTHON_LOADER=ON -DOPENCV_GENERATE_SETUPVARS=OFF \
  -DOPENCV_PYTHON_SKIP_LINKER_EXCLUDE_LIBS=ON \
  -DCMAKE_SKIP_INSTALL_RPATH=ON -DCPU_BASELINE=SSE3 \
  -DCPU_DISPATCH=SSE4_1,SSE4_2,AVX,AVX2

cmake --build "$BUILD" --parallel "${HIMMELCAD_BUILD_JOBS:-2}"
cmake --install "$BUILD"

MODULE="$(find "$INSTALL/site-packages" -maxdepth 1 -type f -name 'cv2*.so' -print -quit)"
[[ -n "$MODULE" ]] || { echo "OpenCV Python module was not installed" >&2; exit 1; }
if ldd "$MODULE" | grep -Eiq 'ffmpeg|avcodec|avformat|gstreamer|openblas|gfortran|quadmath|gomp|iomp'; then
  echo "Forbidden OpenCV runtime dependency" >&2
  ldd "$MODULE" >&2
  exit 1
fi
MAX_GLIBC="$(readelf --version-info "$MODULE" | grep -Eo 'GLIBC_[0-9.]+' | sort -Vu | tail -1)"
[[ "$(printf '%s\n%s\n' GLIBC_2.28 "$MAX_GLIBC" | sort -Vu | tail -1)" == "GLIBC_2.28" ]] || {
  echo "OpenCV exceeded its GLIBC_2.28 baseline: $MAX_GLIBC" >&2
  exit 1
}

rm -rf "$STAGE"
mkdir -p "$STAGE/$DIST_INFO/licenses/opencv"
install -m 0644 "$MODULE" "$STAGE/$(basename "$MODULE")"
install -m 0644 "$ROOT/runtime/opencv-wheel/METADATA" "$STAGE/$DIST_INFO/METADATA"
install -m 0644 "$SOURCE_ROOT/LICENSE" "$STAGE/$DIST_INFO/licenses/opencv/LICENSE"
cp -a "$INSTALL/share/licenses/opencv4/." "$STAGE/$DIST_INFO/licenses/opencv/"
mkdir -p "$STAGE/$DIST_INFO/licenses/toolchain"
install -m 0644 "$ZIG_ROOT/LICENSE" "$STAGE/$DIST_INFO/licenses/toolchain/zig-MIT.txt"
install -m 0644 "$ZIG_ROOT/lib/libcxx/LICENSE.TXT" "$STAGE/$DIST_INFO/licenses/toolchain/libcxx-Apache-2.0-LLVM-exception.txt"
install -m 0644 "$ZIG_ROOT/lib/libcxxabi/LICENSE.TXT" "$STAGE/$DIST_INFO/licenses/toolchain/libcxxabi-Apache-2.0-LLVM-exception.txt"
install -m 0644 "$ZIG_ROOT/lib/libunwind/LICENSE.TXT" "$STAGE/$DIST_INFO/licenses/toolchain/libunwind-Apache-2.0-LLVM-exception.txt"
python3 "$ROOT/scripts/package-staged-python-wheel.py" \
  --site-packages "$STAGE" \
  --module "$(basename "$MODULE")" \
  --dist-info "$DIST_INFO" \
  --tag cp312-cp312-manylinux_2_28_x86_64 \
  --output "$OUTPUT"

echo "OpenCV release wheel: $OUTPUT"
echo "SHA-256: $(sha256_file "$OUTPUT")"
echo "Native closure:"
ldd "$MODULE"
echo "Maximum glibc symbol: $MAX_GLIBC"
