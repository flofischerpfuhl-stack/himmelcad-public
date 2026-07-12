import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const suffix = process.platform === 'win32' ? '.exe' : '';
const candidates = [
  process.env.CARGO,
  process.env.HOME ? join(process.env.HOME, '.cargo', 'bin', `cargo${suffix}`) : null,
  process.env.USERPROFILE ? join(process.env.USERPROFILE, '.cargo', 'bin', `cargo${suffix}`) : null,
  `cargo${suffix}`,
].filter(Boolean);
const cargo = candidates.find(
  (candidate) => candidate === `cargo${suffix}` || existsSync(candidate),
);
if (!cargo) throw new Error('Cargo was not found. Install the pinned Rust toolchain or set CARGO.');
const result = spawnSync(cargo, process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
