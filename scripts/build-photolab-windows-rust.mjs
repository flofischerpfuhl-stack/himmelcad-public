#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const toolchain =
  process.env.HIMMELCAD_LLVM_MINGW_ROOT ??
  join(root, '.build', 'llvm-mingw', 'llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64');
const bin = join(toolchain, 'bin');
const linker = join(bin, 'x86_64-w64-mingw32-clang');
const archiver = join(bin, 'llvm-ar');
const homeCargo = process.env.HOME ? join(process.env.HOME, '.cargo', 'bin', 'cargo') : null;
const cargo = process.env.CARGO ?? (homeCargo && existsSync(homeCargo) ? homeCargo : 'cargo');
if (!existsSync(linker) || !existsSync(archiver)) {
  throw new Error(`Pinned LLVM-MinGW toolchain is missing: ${toolchain}`);
}
const result = spawnSync(
  cargo,
  [
    'build',
    '--release',
    '--target',
    'x86_64-pc-windows-gnullvm',
    '--bins',
    '--package',
    'himmelcad-sidecar',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER: linker,
      CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_AR: archiver,
      CC_x86_64_pc_windows_gnullvm: linker,
      CXX_x86_64_pc_windows_gnullvm: join(bin, 'x86_64-w64-mingw32-clang++'),
    },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const release = join(root, 'target', 'x86_64-pc-windows-gnullvm', 'release');
const unwind = join(toolchain, 'x86_64-w64-mingw32', 'bin', 'libunwind.dll');
if (!existsSync(unwind)) throw new Error(`LLVM-MinGW libunwind runtime is missing: ${unwind}`);
mkdirSync(release, { recursive: true });
copyFileSync(unwind, join(release, 'libunwind.dll'));
