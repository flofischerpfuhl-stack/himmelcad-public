$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BuildRoot = if ($env:HIMMELCAD_COLMAP_BUILD_ROOT) { $env:HIMMELCAD_COLMAP_BUILD_ROOT } else { Join-Path $Root ".build/colmap-worker-win" }
$VcpkgRoot = if ($env:HIMMELCAD_VCPKG_ROOT) { $env:HIMMELCAD_VCPKG_ROOT } else { Join-Path $BuildRoot "vcpkg" }
$Source = Join-Path $BuildRoot "colmap"
$Build = Join-Path $BuildRoot "build"
$Install = Join-Path $Root "vendor/colmap/win32-x64"
$ClapackModule = Join-Path $Build "vcpkg_installed/x64-windows-static-release/share/clapack"
$Toolchain = Join-Path $VcpkgRoot "scripts/buildsystems/vcpkg.cmake"
$Jobs = if ($env:HIMMELCAD_BUILD_JOBS) { $env:HIMMELCAD_BUILD_JOBS } else { [Environment]::ProcessorCount }
$VcpkgCommit = "03e366fb91e38b9432ebd5f8cc79f7c8f55e96ab"

New-Item -ItemType Directory -Force -Path $BuildRoot, $Install | Out-Null
if (-not (Test-Path (Join-Path $VcpkgRoot ".git"))) {
  git clone --filter=blob:none --no-checkout https://github.com/microsoft/vcpkg.git $VcpkgRoot
}
git -C $VcpkgRoot cat-file -e "$VcpkgCommit`^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
  git -C $VcpkgRoot fetch --depth 1 origin $VcpkgCommit
}
git -C $VcpkgRoot checkout --detach $VcpkgCommit
if (-not (Test-Path (Join-Path $VcpkgRoot "vcpkg.exe"))) {
  & (Join-Path $VcpkgRoot "bootstrap-vcpkg.bat") -disableMetrics
}
if (-not (Test-Path (Join-Path $Source ".git"))) {
  git clone --depth 1 --branch 4.1.0 https://github.com/colmap/colmap.git $Source
}
git -C $Source reset --hard 4.1.0
git -C $Source apply (Join-Path $Root "patches/colmap-4.1.0-no-copyleft.patch")

cmake -S $Source -B $Build `
  -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_INSTALL_PREFIX=$Install `
  -DCMAKE_TOOLCHAIN_FILE=$Toolchain `
  -DVCPKG_TARGET_TRIPLET=x64-windows-static-release `
  -DHIMMELCAD_LAPACK_MODULE_PATH=$ClapackModule `
  -DGUI_ENABLED=OFF `
  -DCGAL_ENABLED=OFF `
  -DDOWNLOAD_ENABLED=OFF `
  -DTESTS_ENABLED=OFF `
  -DCUDA_ENABLED=OFF `
  -DOPENMP_ENABLED=OFF `
  -DONNX_ENABLED=ON `
  -DOPENGL_ENABLED=OFF `
  -DMVS_ENABLED=ON `
  -DLSD_ENABLED=OFF `
  -DIPO_ENABLED=ON
cmake --build $Build --config Release --parallel $Jobs
cmake --install $Build --config Release
& (Join-Path $Install "bin/colmap.exe") help
