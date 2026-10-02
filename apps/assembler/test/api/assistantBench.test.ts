/**
 * The assistant benchmark in CI (`bench/assistant/run.mjs --provider
 * scripted`): plain-language tasks replayed by the scripted stand-in
 * harness through `assembler-headless --mcp`, checked on the saved project.
 * No AI provider is called; real CLIs are benchmarked by hand.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

void test('scripted assistant benchmark: every plain-language task passes its acceptance checks', () => {
  const out = mkdtempSync(join(tmpdir(), 'assembler-assistant-bench-'));
  try {
    const run = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'bench', 'assistant', 'run.mjs'),
        '--provider',
        'scripted',
        '--out',
        out,
      ],
      { encoding: 'utf8', timeout: 280_000 },
    );
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as {
      results: { task: string; passed: boolean; toolCalls: number }[];
    };
    assert.ok(results.results.length >= 2);
    for (const result of results.results) {
      assert.equal(result.passed, true, result.task);
      assert.ok(result.toolCalls > 0, result.task);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
