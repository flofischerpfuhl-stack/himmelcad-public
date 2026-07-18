import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const platform = process.argv[2] ?? `${process.platform}-${process.arch}`;
const output = join(root, '.build', 'photolab-runtime', platform);

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

if (platform === 'linux-x64') stageLinux();
else if (platform === 'win32-x64') stageWindows();
else throw new Error(`Unsupported PhotoLab release platform: ${platform}`);

function stageLinux() {
  stageColmapRuntime('linux-x64');
  stageDedodeRuntime('linux-x64');
  stageGeoRuntime('linux-x64', [
    'gdal_grid',
    'gdal_rasterize',
    'gdalwarp',
    'gdalbuildvrt',
    'gdal_translate',
    'gdalinfo',
    'ogrinfo',
    'ogr2ogr',
  ]);
}

function stageWindows() {
  const msvcRuntime = join(root, 'vendor', 'msvc-runtime', 'win32-x64');
  execFileSync(process.execPath, [join(root, 'scripts', 'fetch-msvc-runtime.mjs')], {
    stdio: 'inherit',
  });
  const colmapBin = stageColmapRuntime('win32-x64');
  stageDedodeRuntime('win32-x64');
  stageGeoRuntime('win32-x64', [
    'gdal_grid.exe',
    'gdal_rasterize.exe',
    'gdalwarp.exe',
    'gdalbuildvrt.exe',
    'gdal_translate.exe',
    'gdalinfo.exe',
    'ogrinfo.exe',
    'ogr2ogr.exe',
  ]);
  const llvmRoot =
    process.env.HIMMELCAD_LLVM_MINGW_ROOT ??
    join(
      root,
      '.build',
      'llvm-mingw',
      'llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64',
      'x86_64-w64-mingw32',
      'bin',
    );
  const llvmBin = llvmRoot.endsWith(`${join('x86_64-w64-mingw32', 'bin')}`)
    ? llvmRoot
    : join(llvmRoot, 'x86_64-w64-mingw32', 'bin');
  for (const runtime of ['libc++.dll', 'libunwind.dll', 'libwinpthread-1.dll']) {
    copyRequired(join(llvmBin, runtime), join(output, 'workers', 'geo', 'bin', runtime));
    copyRequired(join(llvmBin, runtime), join(colmapBin, runtime));
  }
  const mingwShare = join(dirname(llvmBin), 'share', 'mingw32');
  copyRequired(
    join(mingwShare, 'COPYING.winpthreads.txt'),
    join(output, 'workers', 'geo', 'bin', 'LICENSE-winpthreads.txt'),
  );
  copyRequired(
    join(mingwShare, 'COPYING.winpthreads.txt'),
    join(colmapBin, 'LICENSE-winpthreads.txt'),
  );
  const dedodePython = join(output, 'workers', 'dedode', 'python');
  for (const runtime of [
    'msvcp140.dll',
    'msvcp140_1.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
  ]) {
    copyRequired(join(msvcRuntime, runtime), join(colmapBin, runtime));
    copyRequired(join(msvcRuntime, runtime), join(dedodePython, runtime));
  }
  copyRequired(
    join(msvcRuntime, 'LICENSE.rtf'),
    join(colmapBin, 'LICENSE-Microsoft-VC-Runtime.rtf'),
  );
  copyRequired(
    join(msvcRuntime, 'LICENSE.rtf'),
    join(dedodePython, 'LICENSE-Microsoft-VC-Runtime.rtf'),
  );
}

function stageColmapRuntime(target) {
  const source = join(root, 'vendor', 'colmap', target);
  const destination = join(output, 'workers', 'colmap');
  copyRequired(source, destination);
  return join(destination, 'bin');
}

function stageDedodeRuntime(target) {
  const configured = process.env.HIMMELCAD_DEDODE_RELEASE_ROOT;
  const source = configured ? resolve(configured) : join(root, '.build', 'dedode-runtime', target);
  const destination = join(output, 'workers', 'dedode');
  copyRequired(join(source, 'python'), join(destination, 'python'));
  const python = join(destination, 'python');
  const sitePackages =
    target === 'win32-x64'
      ? join(python, 'Lib', 'site-packages')
      : join(python, 'lib', 'python3.12', 'site-packages');
  for (const path of [
    join(python, 'bin', 'pip'),
    join(python, 'bin', 'pip3'),
    join(python, 'bin', 'pip3.12'),
    join(python, 'Scripts', 'pip.exe'),
    join(python, 'Scripts', 'pip3.exe'),
    join(python, 'Scripts', 'pip3.12.exe'),
    join(python, 'lib', 'python3.12', 'ensurepip'),
    join(python, 'Lib', 'ensurepip'),
    join(python, 'include'),
    join(python, 'libs'),
    join(python, 'Scripts'),
    join(python, 'pythonw.exe'),
    join(python, 'tcl'),
    join(python, 'Lib', 'idlelib'),
    join(python, 'Lib', 'lib2to3'),
    join(python, 'Lib', 'msilib'),
    join(python, 'Lib', 'tkinter'),
    join(python, 'Lib', 'turtledemo'),
    join(python, 'Lib', 'venv'),
    join(sitePackages, 'pip'),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
  pruneDevelopmentFiles(python);
  if (target === 'linux-x64') {
    const executable = join(destination, 'python', 'bin', 'python3');
    if (!existsSync(executable)) {
      throw new Error(`DeDoDe Python executable is missing: ${executable}`);
    }
  } else if (!existsSync(join(destination, 'python', 'python.exe'))) {
    throw new Error(
      `DeDoDe Python executable is missing: ${join(destination, 'python', 'python.exe')}`,
    );
  }
  copyRequired(join(root, 'vendor', 'dedode', 'onnx'), join(destination, 'models'));
  copyRequired(
    join(root, 'vendor', 'dedode', 'ONNX_MODELS.json'),
    join(destination, 'ONNX_MODELS.json'),
  );
  copyRequired(
    join(root, 'apps', 'photolab', 'workers', 'dedode', 'dedode_onnx_worker.py'),
    join(destination, 'dedode_onnx_worker.py'),
  );
}

/** @param {string} directory */
function pruneDevelopmentFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      (entry.isDirectory() &&
        (entry.name === '__pycache__' ||
          entry.name === 'test' ||
          entry.name === 'tests' ||
          /^pip(?:-.+\.dist-info)?$/i.test(entry.name))) ||
      (entry.isFile() &&
        (entry.name.endsWith('.pyc') ||
          entry.name.endsWith('.pyo') ||
          entry.name.endsWith('.a') ||
          entry.name.endsWith('.lib')))
    ) {
      rmSync(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      pruneDevelopmentFiles(path);
    }
  }
}

function stageGeoRuntime(target, gdalTools) {
  const configured = process.env.HIMMELCAD_GEO_RUNTIME_ROOT;
  const source = configured
    ? resolve(configured)
    : join(
        root,
        '.build',
        'photolab-geo',
        target === 'linux-x64' ? 'vcpkg_installed' : 'vcpkg_installed-win',
        target === 'linux-x64' ? 'x64-linux-release' : 'x64-mingw-static',
      );
  const destination = join(output, 'workers', 'geo');
  for (const tool of gdalTools) {
    copyRequired(join(source, 'tools', 'gdal', tool), join(destination, 'bin', tool));
  }
  const projSource = existsSync(join(source, 'tools', 'proj'))
    ? source
    : join(
        root,
        '.build',
        'photolab-proj-tools',
        target === 'linux-x64' ? 'vcpkg_installed' : 'vcpkg_installed-win',
        target === 'linux-x64' ? 'x64-linux-release' : 'x64-mingw-static',
      );
  for (const tool of target === 'linux-x64' ? ['cct', 'projinfo'] : ['cct.exe', 'projinfo.exe']) {
    copyRequired(join(projSource, 'tools', 'proj', tool), join(destination, 'bin', tool));
  }
  copyRequired(join(source, 'share', 'gdal'), join(destination, 'share', 'gdal'));
  copyRequired(join(source, 'share', 'proj'), join(destination, 'share', 'proj'));
  copyRequired(
    join(root, 'vendor', 'proj-data', 'de_adv_BETA2007.tif'),
    join(destination, 'share', 'proj', 'de_adv_BETA2007.tif'),
  );
  copyRequired(
    join(root, 'vendor', 'proj-data', 'de_bkg_gcg2016.tif'),
    join(destination, 'share', 'proj', 'de_bkg_gcg2016.tif'),
  );
  copyRequired(
    join(root, 'vendor', 'proj-data', 'de_lgvl_saarland_SeTa2016.tif'),
    join(destination, 'share', 'proj', 'de_lgvl_saarland_SeTa2016.tif'),
  );
  if (target === 'linux-x64') {
    for (const tool of [...gdalTools, 'cct', 'projinfo']) {
      const path = join(destination, 'bin', tool);
      const dependencies = execFileSync('ldd', [path], { encoding: 'utf8' });
      if (/lib(?:gomp|gfortran|quadmath|iomp5)/i.test(dependencies)) {
        throw new Error(`Forbidden copyleft runtime dependency in ${path}`);
      }
    }
  }
}

/** @param {string} source @param {string} destination */
function copyRequired(source, destination) {
  if (!existsSync(source)) throw new Error(`Required release runtime is missing: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
}
