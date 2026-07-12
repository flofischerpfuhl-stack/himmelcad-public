#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${HIMMELCAD_COLMAP_BUILD_ROOT:-$ROOT/.build/colmap-worker}"
VCPKG_ROOT="${HIMMELCAD_VCPKG_ROOT:-$BUILD_ROOT/vcpkg}"
SOURCE="$BUILD_ROOT/colmap"
BUILD="$BUILD_ROOT/build"
INSTALL="$ROOT/vendor/colmap/linux-x64"
CLAPACK_MODULE="$BUILD/vcpkg_installed/x64-linux-release/share/clapack"
VCPKG_COMMIT="03e366fb91e38b9432ebd5f8cc79f7c8f55e96ab"

mkdir -p "$BUILD_ROOT" "$INSTALL"
if [[ ! -d "$VCPKG_ROOT/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/microsoft/vcpkg.git "$VCPKG_ROOT"
fi
if ! git -C "$VCPKG_ROOT" cat-file -e "$VCPKG_COMMIT^{commit}" 2>/dev/null; then
  git -C "$VCPKG_ROOT" fetch --depth 1 origin "$VCPKG_COMMIT"
fi
git -C "$VCPKG_ROOT" checkout --detach "$VCPKG_COMMIT"
if [[ ! -x "$VCPKG_ROOT/vcpkg" ]]; then
  "$VCPKG_ROOT/bootstrap-vcpkg.sh" -disableMetrics
fi
if [[ ! -d "$SOURCE/.git" ]]; then
  git clone --depth 1 --branch 4.1.0 https://github.com/colmap/colmap.git "$SOURCE"
fi
git -C "$SOURCE" reset --hard 4.1.0
git -C "$SOURCE" apply "$ROOT/patches/colmap-4.1.0-no-copyleft.patch"

cmake -S "$SOURCE" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$INSTALL" \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DHIMMELCAD_LAPACK_MODULE_PATH="$CLAPACK_MODULE" \
  -DVCPKG_TARGET_TRIPLET=x64-linux-release \
  -DGUI_ENABLED=OFF \
  -DCGAL_ENABLED=OFF \
  -DDOWNLOAD_ENABLED=OFF \
  -DTESTS_ENABLED=OFF \
  -DCUDA_ENABLED=OFF \
  -DOPENMP_ENABLED=OFF \
  -DONNX_ENABLED=ON \
  -DOPENGL_ENABLED=OFF \
  -DMVS_ENABLED=ON \
  -DLSD_ENABLED=OFF \
  -DIPO_ENABLED=ON
cmake --build "$BUILD" --parallel "${HIMMELCAD_BUILD_JOBS:-$(nproc)}"
cmake --install "$BUILD"
"$INSTALL/bin/colmap" -h
