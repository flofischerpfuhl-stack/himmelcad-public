#!/usr/bin/env node

import { resolve } from 'node:path';
import process from 'node:process';

import { changedPathsForTier, shallowUnknownUntracked } from './verification/git-changes.mjs';
import { createVerificationPlan } from './verification/planner.mjs';
import { runPlan } from './verification/runner.mjs';

const root = resolve(import.meta.dirname, '..');
const tier = process.argv[2] ?? 'changed';
if (!['changed', 'commit', 'push', 'release'].includes(tier)) {
  throw new Error(`unknown verification tier: ${tier}`);
}
const readOption = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
};
const dryRun = process.argv.includes('--dry-run');
const explicitPaths = process.argv
  .filter((argument) => argument.startsWith('--path='))
  .map((argument) => argument.slice(7));
const paths = explicitPaths.length
  ? explicitPaths
  : changedPathsForTier(tier, { base: readOption('base') });
const capabilities = (readOption('capabilities') ?? '').split(',').filter(Boolean);

if (tier === 'changed') {
  for (const path of shallowUnknownUntracked()) {
    process.stderr.write(
      `Notice: untracked path is outside verification source roots and was not traversed: ${path}\n`,
    );
  }
}

const plan = createVerificationPlan({ root, tier, paths });
process.exitCode = runPlan(plan, { root, dryRun, capabilities });
