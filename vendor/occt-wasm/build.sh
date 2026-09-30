#!/bin/bash
# Rebuilds the HimmelCAD OCCT WebAssembly module (vendor/occt-wasm/dist/
# himmelcad_occt.{js,wasm,d.ts}) from pinned public inputs. Linux x86_64,
# run as root (chroot); no Docker needed. See README.md.
#
#   sudo vendor/occt-wasm/build.sh [--verify-replicad] [--work DIR]
#
# --verify-replicad also relinks replicad's unmodified configuration and
# checks it against the published replicad-opencascadejs 1.1.0 files (proves
# the toolchain before trusting the HimmelCAD build).
set -euo pipefail

# ---- pinned inputs (keep in sync with PINS.md and LICENSES/THIRD_PARTY.md) ----
REPLICAD_REPO=https://github.com/sgenoud/replicad.git
REPLICAD_COMMIT=e4b05f67dc4e2393a876ce8c5064a9c93db05bf1
OCJS_COMMIT=ebd263f15337b440b391492af073662707e86482
# ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded, linux/amd64 manifest
# (index sha256:215198af0e2ca4c5f308e5540869f2419784dc290062d3eb03d34e4f22e0188c).
IMAGE_DIGEST=sha256:deb9be8470038652c060b47f2d2e7e2e46d899bb896ecabb007bf60307ee2d54
REPLICAD_WASM_SHA256=4c9f22e9f3828dca6f3c95405934cdbe624e593c35266f47f392ab337478dbde
REPLICAD_JS_SHA256=018e57538fcb773f0124eae60aee4de693d3aae01c55b2b883a874911ab121c3

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${OCCT_WASM_WORK:-/root/occt-asm}"
VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --verify-replicad) VERIFY=1 ;;
    --work) shift; WORK="$1" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" = 0 ] || { echo "run as root (chroot, bind mounts)" >&2; exit 1; }

mkdir -p "$WORK/src" "$WORK/logs"
R="$WORK/image/rootfs"

echo "== 1. replicad build configuration @ $REPLICAD_COMMIT"
if [ ! -d "$WORK/src/replicad/.git" ]; then
  git init -q "$WORK/src/replicad"
  git -C "$WORK/src/replicad" remote add origin "$REPLICAD_REPO"
fi
git -C "$WORK/src/replicad" fetch -q --depth 1 origin "$REPLICAD_COMMIT"
git -C "$WORK/src/replicad" checkout -q FETCH_HEAD
[ "$(git -C "$WORK/src/replicad" rev-parse HEAD)" = "$REPLICAD_COMMIT" ]
RC="$WORK/src/replicad/packages/replicad-opencascadejs/build-config"

echo "== 2. opencascade.js toolchain image $IMAGE_DIGEST (OCCT V8_0_1, opencascade.js $OCJS_COMMIT, emsdk 5.0.1)"
python3 "$HERE/tools/pull-image.py" "$IMAGE_DIGEST" "$WORK/image"
grep -q "OCJS_SOURCE_COMMIT=$OCJS_COMMIT" "$WORK/image/config.json"

run_in_image() { # <log> <output dir in image> <command>
  local log="$1" out="$2"; shift 2
  for d in proc sys dev dev/pts; do
    mkdir -p "$R/$d"
    mountpoint -q "$R/$d" || mount --bind "/$d" "$R/$d"
  done
  cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || true
  # Environment of the image's config (Docker ENV), see $WORK/image/config.json.
  env -i HOME=/root TERM=xterm \
    PATH=/opencascade.js/.venv/bin:/usr/local/bin:/usr/bin:/bin:/emsdk:/emsdk/upstream/emscripten:/emsdk/node/22.16.0_64bit/bin:/usr/local/sbin:/usr/sbin:/sbin \
    EMSDK=/emsdk UV_PYTHON_INSTALL_DIR=/opt/uv-python OCCT_ROOT=/occt RAPIDJSON_ROOT=/rapidjson FREETYPE_ROOT=/freetype \
    NX_DAEMON=false OCJS_CONFIG=single-threaded THREADING=single-threaded \
    OCJS_SOURCE_COMMIT="$OCJS_COMMIT" SOURCE_DATE_EPOCH=1785713531 OCJS_OUTPUT_DIR="$out" \
    chroot "$R" /bin/bash -c "$*" > "$log" 2>&1 || { tail -40 "$log"; return 1; }
}

if [ "$VERIFY" = 1 ]; then
  echo "== 3a. relink replicad's configuration unchanged (docker run -v build-config:/src … link custom_build_single.yml)"
  cp -r "$RC"/* "$R/src/"
  run_in_image "$WORK/logs/replicad-link.log" /src "cd /opencascade.js && ./build-wasm.sh link /src/custom_build_single.yml"
  echo "$REPLICAD_WASM_SHA256  $R/src/replicad_single.wasm" | sha256sum -c -
  echo "$REPLICAD_JS_SHA256  $R/src/replicad_single.js" | sha256sum -c -
fi

echo "== 3. link the HimmelCAD configuration"
rm -rf "$R/src/himmelcad"
mkdir -p "$R/src/himmelcad/wrappers"
cp "$RC"/wrappers/*.cpp "$R/src/himmelcad/wrappers/"
cp "$HERE"/build-config/wrappers/*.cpp "$R/src/himmelcad/wrappers/"
python3 "$HERE/build-config/render-config.py" "$RC/custom_build_single.yml" \
  "$HERE/build-config/extra-bindings.yml" "$R/src/himmelcad/himmelcad_occt.yml"
start=$(date +%s)
run_in_image "$WORK/logs/himmelcad-link.log" /src/himmelcad/out \
  "cd /opencascade.js && ./build-wasm.sh link /src/himmelcad/himmelcad_occt.yml"
echo "   link took $(( $(date +%s) - start )) s"

echo "== 4. copy to $HERE/dist"
mkdir -p "$HERE/dist"
for f in himmelcad_occt.js himmelcad_occt.wasm himmelcad_occt.d.ts himmelcad_occt.build-manifest.json; do
  cp "$R/src/himmelcad/out/$f" "$HERE/dist/$f"
done
cp "$R/src/himmelcad/himmelcad_occt.yml" "$HERE/dist/himmelcad_occt.yml"
( cd "$HERE/dist" && sha256sum himmelcad_occt.js himmelcad_occt.wasm himmelcad_occt.d.ts himmelcad_occt.yml > SHA256SUMS )
cat "$HERE/dist/SHA256SUMS"
if ( cd "$HERE" && sha256sum -c --quiet artifacts.sha256 ); then
  echo "== identical to the recorded build (artifacts.sha256)"
else
  echo "== WARNING: differs from artifacts.sha256 (changed inputs or a non-reproducible step)"
fi
