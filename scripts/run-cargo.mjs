import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { resolveCargoExecutable } from './verification/cargo-resolver.mjs';

const cargo = resolveCargoExecutable();
const result = spawnSync(cargo, process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
