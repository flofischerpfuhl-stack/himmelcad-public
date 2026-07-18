#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${HIMMELCAD_COLMAP_BUILD_ROOT:-$ROOT/.build/colmap-worker}"
VCPKG_ROOT="${HIMMELCAD_VCPKG_ROOT:-$BUILD_ROOT/vcpkg}"
LLVM_ROOT="${HIMMELCAD_LLVM_MINGW_ROOT:-$ROOT/.build/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64}"
SOURCE="$BUILD_ROOT/colmap"
BUILD="$BUILD_ROOT/build-win"
INSTALL="$ROOT/vendor/colmap/win32-x64"
TRIPLET="x64-mingw-static-himmelcad"
TRIPLET_ROOT="$BUILD_ROOT/triplets"
OVERLAY_PORTS="$BUILD_ROOT/overlay-ports"
CLAPACK_MODULE="$BUILD/vcpkg_installed/$TRIPLET/share/clapack"
PATCH="$ROOT/patches/colmap-4.1.0-no-copyleft.patch"
VCPKG_COMMIT="03e366fb91e38b9432ebd5f8cc79f7c8f55e96ab"
LLVM_ARCHIVE="$ROOT/.build/llvm-mingw/toolchain.tar.xz"
LLVM_URL="https://github.com/mstorsjo/llvm-mingw/releases/download/20260407/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64.tar.xz"
LLVM_SHA256="c39aeb4823bbc89ce2a40820964a114614a524c2cb7be1e3dafd16f780fa39b1"

mkdir -p "$BUILD_ROOT" "$(dirname "$LLVM_ARCHIVE")"
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
if [[ ! -x "$LLVM_ROOT/bin/x86_64-w64-mingw32-clang++" ]]; then
  curl -fL --retry 3 "$LLVM_URL" -o "$LLVM_ARCHIVE"
  echo "$LLVM_SHA256  $LLVM_ARCHIVE" | sha256sum --check --strict
  tar -xJf "$LLVM_ARCHIVE" -C "$(dirname "$LLVM_ARCHIVE")"
fi
[[ -x "$LLVM_ROOT/bin/x86_64-w64-mingw32-clang++" ]] || {
  echo "Pinned LLVM-MinGW is missing: $LLVM_ROOT" >&2
  exit 1
}
if [[ ! -d "$SOURCE/.git" ]]; then
  git clone --depth 1 --branch 4.1.0 https://github.com/colmap/colmap.git "$SOURCE"
fi
if [[ "$(git -C "$SOURCE" rev-parse HEAD)" != "$(git -C "$SOURCE" rev-parse 4.1.0^{commit})" ]]; then
  echo "Existing COLMAP source is not the pinned 4.1.0 commit: $SOURCE" >&2
  exit 1
fi
if git -C "$SOURCE" apply --reverse --check "$PATCH" 2>/dev/null; then
  :
elif git -C "$SOURCE" apply --check "$PATCH"; then
  git -C "$SOURCE" apply "$PATCH"
else
  echo "COLMAP source contains changes outside the audited patch: $SOURCE" >&2
  exit 1
fi

mkdir -p "$BUILD" "$INSTALL" "$TRIPLET_ROOT" "$OVERLAY_PORTS"
if [[ ! -d "$OVERLAY_PORTS/opencolorio" ]]; then
  cp -a "$VCPKG_ROOT/ports/opencolorio" "$OVERLAY_PORTS/opencolorio"
fi
if ! grep -q 'opencolorio-2.5.2-libcxx-wide-path.patch' \
  "$OVERLAY_PORTS/opencolorio/portfile.cmake"; then
  sed -i '/        pystring.diff/a\        opencolorio-2.5.2-libcxx-wide-path.patch' \
    "$OVERLAY_PORTS/opencolorio/portfile.cmake"
fi
cp "$ROOT/patches/opencolorio-2.5.2-libcxx-wide-path.patch" \
  "$OVERLAY_PORTS/opencolorio/opencolorio-2.5.2-libcxx-wide-path.patch"
FAISS_ARCHIVE="$BUILD_ROOT/build/_deps/faiss-subbuild/faiss-populate-prefix/src/v1.14.1.zip"
if [[ -f "$FAISS_ARCHIVE" ]]; then
  FAISS_DOWNLOAD="$BUILD/_deps/faiss-subbuild/faiss-populate-prefix/src/v1.14.1.zip"
  mkdir -p "$(dirname "$FAISS_DOWNLOAD")"
  cp "$FAISS_ARCHIVE" "$FAISS_DOWNLOAD"
fi
cat > "$TRIPLET_ROOT/$TRIPLET.cmake" <<'EOF'
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_ENV_PASSTHROUGH PATH)
set(VCPKG_CMAKE_SYSTEM_NAME MinGW)
set(VCPKG_C_FLAGS "-D_WIN32_WINNT=0x0602")
set(VCPKG_CXX_FLAGS "-D_WIN32_WINNT=0x0602")
EOF
export PATH="$LLVM_ROOT/bin:$PATH"
export VCPKG_MAX_CONCURRENCY="${HIMMELCAD_BUILD_JOBS:-$(nproc)}"
NINJA="$(find "$VCPKG_ROOT/downloads/tools" -type f -name ninja -perm -u+x 2>/dev/null | head -n 1)"
[[ -n "$NINJA" ]] || { echo "vcpkg Ninja is missing below $VCPKG_ROOT/downloads/tools" >&2; exit 1; }
cmake -S "$SOURCE" -B "$BUILD" \
  -G Ninja \
  -DCMAKE_SYSTEM_NAME=Windows \
  -DCMAKE_SYSTEM_PROCESSOR=x86_64 \
  -DCMAKE_MAKE_PROGRAM="$NINJA" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DCMAKE_INSTALL_PREFIX="$INSTALL" \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DCMAKE_C_COMPILER="$LLVM_ROOT/bin/x86_64-w64-mingw32-clang" \
  -DCMAKE_CXX_COMPILER="$LLVM_ROOT/bin/x86_64-w64-mingw32-clang++" \
  -DCMAKE_RC_COMPILER="$LLVM_ROOT/bin/x86_64-w64-mingw32-windres" \
  -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
  -DVCPKG_HOST_TRIPLET=x64-linux \
  -DVCPKG_OVERLAY_TRIPLETS="$TRIPLET_ROOT" \
  -DVCPKG_OVERLAY_PORTS="$OVERLAY_PORTS" \
  -DVCPKG_APPLOCAL_DEPS=OFF \
  -DHIMMELCAD_LAPACK_MODULE_PATH="$CLAPACK_MODULE" \
  -DGUI_ENABLED=OFF \
  -DCGAL_ENABLED=OFF \
  -DDOWNLOAD_ENABLED=OFF \
  -DTESTS_ENABLED=OFF \
  -DCUDA_ENABLED=OFF \
  -DOPENMP_ENABLED=OFF \
  -DONNX_ENABLED=ON \
  -DFETCH_ONNX=ON \
  -DOPENGL_ENABLED=OFF \
  -DMVS_ENABLED=ON \
  -DLSD_ENABLED=OFF \
  -DIPO_ENABLED=ON
cmake --build "$BUILD" --parallel "${HIMMELCAD_BUILD_JOBS:-$(nproc)}"
for runtime in onnxruntime.dll onnxruntime_providers_shared.dll; do
  cp "$BUILD/_deps/onnxruntime-build/lib/$runtime" "$BUILD/src/colmap/exe/$runtime"
done
cmake --install "$BUILD"

COLMAP="$INSTALL/bin/colmap.exe"
[[ -f "$COLMAP" ]] || { echo "Windows COLMAP output is missing: $COLMAP" >&2; exit 1; }
node "$ROOT/scripts/fetch-msvc-runtime.mjs"
for runtime in libc++.dll libunwind.dll libwinpthread-1.dll; do
  cp "$LLVM_ROOT/x86_64-w64-mingw32/bin/$runtime" "$INSTALL/bin/$runtime"
done
cp "$LLVM_ROOT/x86_64-w64-mingw32/share/mingw32/COPYING.winpthreads.txt" \
  "$INSTALL/bin/LICENSE-winpthreads.txt"
for runtime in onnxruntime.dll onnxruntime_providers_shared.dll; do
  cp "$BUILD/_deps/onnxruntime-build/lib/$runtime" "$INSTALL/bin/$runtime"
done
for runtime in msvcp140.dll msvcp140_1.dll vcruntime140.dll vcruntime140_1.dll; do
  cp "$ROOT/vendor/msvc-runtime/win32-x64/$runtime" "$INSTALL/bin/$runtime"
done
cp "$ROOT/vendor/msvc-runtime/win32-x64/LICENSE.rtf" \
  "$INSTALL/bin/LICENSE-Microsoft-VC-Runtime.rtf"
IMPORTS="$BUILD/colmap-imports.txt"
"$LLVM_ROOT/bin/llvm-objdump" -p "$COLMAP" | sed -n 's/.*DLL Name: //p' | sort -fu > "$IMPORTS"
if grep -Eiq 'gomp|gfortran|quadmath|iomp|gpl|lgpl|agpl' "$IMPORTS"; then
  echo "Forbidden Windows COLMAP runtime import:" >&2
  cat "$IMPORTS" >&2
  exit 1
fi
node "$ROOT/scripts/write-colmap-vendor-manifest.mjs" win32-x64 "$SOURCE"
echo "Windows COLMAP worker built at $COLMAP"
