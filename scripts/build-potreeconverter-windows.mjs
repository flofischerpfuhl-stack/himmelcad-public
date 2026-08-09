#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const buildRoot = resolve(
  process.env.HIMMELCAD_POTREE_BUILD_ROOT ?? join(root, '.build', 'potreeconverter-win'),
);
const toolchain = resolve(
  process.env.HIMMELCAD_LLVM_MINGW_ROOT ??
    join(root, '.build', 'llvm-mingw', 'llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64'),
);
const source = join(buildRoot, 'source');
const build = join(buildRoot, 'build');
const destination = join(root, 'vendor', 'potreeconverter', 'win32-x64');
const commit = 'd9387d52807bf8936fe98096b9992ea13b50ba94';
const clang = join(toolchain, 'bin', 'x86_64-w64-mingw32-clang++');
const windres = join(toolchain, 'bin', 'x86_64-w64-mingw32-windres');
const objdump = join(toolchain, 'bin', 'llvm-objdump');

for (const executable of [clang, windres, objdump]) {
  if (!existsSync(executable)) throw new Error(`Pinned LLVM-MinGW tool is missing: ${executable}`);
}
mkdirSync(buildRoot, { recursive: true });
if (!existsSync(join(source, '.git'))) {
  run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    '2.1.1',
    'https://github.com/potree/PotreeConverter.git',
    source,
  ]);
}
const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== commit) throw new Error(`PotreeConverter source is not pinned 2.1.1: ${head}`);

replace('Converter/include/HierarchyBuilder.h', [
  ['root_batch_node->type == TYPE::LEAF;', 'root_batch_node->type = TYPE::LEAF;'],
]);
replace('Converter/include/PotreeConverter.h', [
  [
    'auto parallel = std::execution::par;\n\t\tfor_each(parallel, sources.begin(), sources.end(),',
    'for_each(sources.begin(), sources.end(),',
  ],
]);
for (const file of [
  'Converter/include/sampler_poisson.h',
  'Converter/include/sampler_poisson_average.h',
]) {
  replace(file, [
    [
      'Point point = { x, y, z, i, childIndex };',
      'Point point = { x, y, z, static_cast<int32_t>(i), static_cast<int32_t>(childIndex) };',
    ],
    [
      'auto parallel = std::execution::par_unseq;\n\t\t\tstd::sort(parallel, points.begin(), points.end(),',
      'std::sort(points.begin(), points.end(),',
    ],
  ]);
}
replace('Converter/libs/laszip/CMakeLists.txt', [
  ['add_library(laszip SHARED ${source_files})', 'add_library(laszip STATIC ${source_files})'],
]);
replace('Converter/modules/unsuck/unsuck.hpp', [
  [
    'constexpr auto fseek_64_all_platforms = _fseeki64;',
    'inline auto fseek_64_all_platforms = _fseeki64;',
  ],
]);
replace('Converter/modules/unsuck/unsuck_platform_specific.cpp', [
  ['#include "TCHAR.h"', '#include "tchar.h"'],
  ['virtualUsedMax = max(', 'virtualUsedMax = std::max('],
  ['physicalUsedMax = max(', 'physicalUsedMax = std::max('],
]);
replace('Converter/src/indexer.cpp', [
  ['min.x = std::numeric_limits<int64_t>::max();', 'min.x = std::numeric_limits<int32_t>::max();'],
  ['min.y = std::numeric_limits<int64_t>::max();', 'min.y = std::numeric_limits<int32_t>::max();'],
  ['min.z = std::numeric_limits<int64_t>::max();', 'min.z = std::numeric_limits<int32_t>::max();'],
]);
replace('Converter/src/main.cpp', [
  [
    'auto parallel = std::execution::par;\n\tfor_each(parallel, paths.begin(), paths.end(),',
    'for_each(paths.begin(), paths.end(),',
  ],
]);

rmSync(build, { recursive: true, force: true });
run('cmake', [
  '-S',
  source,
  '-B',
  build,
  '-DCMAKE_SYSTEM_NAME=Windows',
  `-DCMAKE_CXX_COMPILER=${clang}`,
  `-DCMAKE_RC_COMPILER=${windres}`,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_EXE_LINKER_FLAGS=-static',
]);
run('cmake', ['--build', build, '--parallel', process.env.HIMMELCAD_BUILD_JOBS ?? '12']);

const binary = join(build, 'PotreeConverter.exe');
if (!existsSync(binary)) throw new Error(`PotreeConverter output is missing: ${binary}`);
const imports =
  execFileSync(objdump, ['-p', binary], { encoding: 'utf8' })
    .match(/DLL Name:\s*([^\s]+)/g)
    ?.map((line) => line.replace(/^.*DLL Name:\s*/, '')) ?? [];
const unexpected = imports.find(
  (name) =>
    !/^(?:api-ms-win-|ext-ms-win-)|^(?:kernel32|kernelbase|ntdll|ucrtbase)\.dll$/i.test(name),
);
if (unexpected) throw new Error(`PotreeConverter has an unbundled runtime import: ${unexpected}`);

mkdirSync(destination, { recursive: true });
rmSync(join(destination, 'laszip.dll'), { force: true });
copyFileSync(binary, join(destination, 'PotreeConverter.exe'));
for (const [from, to] of [
  ['license_potree_converter.txt', 'LICENSE-PotreeConverter.txt'],
  ['license_laszip.txt', 'LICENSE-laszip.txt'],
  ['license_brotli.txt', 'LICENSE-brotli.txt'],
  ['license_json.txt', 'LICENSE-json.txt'],
]) {
  copyFileSync(join(build, 'licenses', from), join(destination, to));
}
copyFileSync(join(build, 'README.md'), join(destination, 'README.md'));
const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
writeFileSync(
  join(destination, 'VENDOR.json'),
  `${JSON.stringify(
    {
      name: 'potreeconverter',
      upstream: 'https://github.com/potree/PotreeConverter',
      license: 'BSD-2-Clause',
      version: '2.1.1',
      commit,
      platform: 'win32-x64',
      toolchain: `llvm-mingw-20260407`,
      patches: [
        'portable sequential standard-algorithm overloads where libc++ has no PSTL',
        'static LASzip and C++ runtime closure',
        'portable Win32 headers/functions and checked integer narrowing',
        'HierarchyBuilder leaf assignment correction',
      ],
      artifacts: { 'PotreeConverter.exe': { sha256 } },
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Windows PotreeConverter built: ${sha256}\n`);

function replace(relativePath, replacements) {
  const path = join(source, relativePath);
  let text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  for (const [before, after] of replacements) {
    if (text.includes(before)) text = text.replace(before, after);
    else if (!text.includes(after)) throw new Error(`Source contract changed in ${relativePath}`);
  }
  writeFileSync(path, text);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
