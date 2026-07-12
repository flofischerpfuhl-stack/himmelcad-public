import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
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
  const python = join(output, 'python');
  const pythonBinary = resolveSymlink('/usr/bin/python3');
  const version = execFileSync(
    pythonBinary,
    ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
    { encoding: 'utf8' },
  ).trim();
  if (version !== '3.12') throw new Error(`DeDoDe release requires Python 3.12, found ${version}`);
  mkdirSync(join(python, 'bin'), { recursive: true });
  mkdirSync(join(python, 'lib'), { recursive: true });
  copyRequired(pythonBinary, join(python, 'bin', 'python3'));
  copyRequired(`/usr/lib/python${version}`, join(python, 'lib', `python${version}`));
  // The development venv intentionally stays out of release staging: the
  // stock PyTorch wheel contains a libgomp runtime forbidden by product policy.
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
  const pythonSource = process.env.HIMMELCAD_WINDOWS_PYTHON_ROOT;
  if (!pythonSource) {
    throw new Error('Windows release staging needs HIMMELCAD_WINDOWS_PYTHON_ROOT.');
  }
  copyRequired(pythonSource, join(output, 'python'));
  const python = join(output, 'python');
  const rootExecutable = join(python, 'python.exe');
  const binExecutable = join(python, 'bin', 'python.exe');
  if (!existsSync(binExecutable)) {
    if (!existsSync(rootExecutable)) {
      throw new Error('Windows Python runtime needs python.exe at its root or bin/python.exe.');
    }
    mkdirSync(dirname(binExecutable), { recursive: true });
    cpSync(rootExecutable, binExecutable);
  }
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
}

function stageGeoRuntime(target, gdalTools) {
  const configured = process.env.HIMMELCAD_GEO_RUNTIME_ROOT;
  const source = configured
    ? resolve(configured)
    : join(
        root,
        '.build',
        'photolab-geo',
        'vcpkg_installed',
        target === 'linux-x64' ? 'x64-linux-release' : 'x64-windows-static-release',
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
        'vcpkg_installed',
        target === 'linux-x64' ? 'x64-linux-release' : 'x64-windows-static-release',
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

/** @param {string} path */
function resolveSymlink(path) {
  return realpathSync(path);
}

/** @param {string} source @param {string} destination */
function copyRequired(source, destination) {
  if (!existsSync(source)) throw new Error(`Required release runtime is missing: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
}
