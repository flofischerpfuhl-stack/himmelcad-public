/** Name completion of expression fields (`chrome/expressionSuggest.ts`). */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptSuggestion,
  identifierAt,
  matchSuggestions,
  moveActive,
  parameterCandidates,
} from '../../renderer/src/chrome/expressionSuggest.js';

const names = (list: { name: string }[]) => list.map((c) => c.name);

void test('the identifier at the caret: names only, not numbers or operators', () => {
  assert.deepEqual(identifierAt('2 * wa', 6), { start: 4, end: 6, prefix: 'wa' });
  assert.deepEqual(identifierAt('wall_2 + 1', 3), { start: 0, end: 6, prefix: 'wal' });
  assert.equal(identifierAt('2 * ', 4), null);
  assert.equal(identifierAt('12', 2), null, 'a number is not a name');
  assert.equal(identifierAt('', 0), null);
});

void test('matches: prefix matches first, then contains; exact single match hides the list', () => {
  const candidates = [
    { name: 'wall' },
    { name: 'wall2' },
    { name: 'side_wall' },
    { name: 'hole_d' },
  ];
  assert.deepEqual(names(matchSuggestions('wa', candidates)), ['wall', 'wall2', 'side_wall']);
  assert.deepEqual(names(matchSuggestions('WALL', candidates)), ['wall', 'wall2', 'side_wall']);
  assert.deepEqual(names(matchSuggestions('hole_d', candidates)), [], 'nothing left to complete');
  assert.deepEqual(names(matchSuggestions('wall', candidates)), ['wall', 'wall2', 'side_wall']);
  assert.equal(
    matchSuggestions(
      'a',
      Array.from({ length: 20 }, (_, i) => ({ name: `a${i}` })),
    ).length,
    8,
  );
});

void test('accepting replaces the whole token and puts the caret after it', () => {
  const text = 'wa * 2';
  const token = identifierAt(text, 2)!;
  assert.deepEqual(acceptSuggestion(text, token, 'wall'), { text: 'wall * 2', caret: 4 });
  const mid = 'x + wal2';
  assert.deepEqual(acceptSuggestion(mid, identifierAt(mid, 6)!, 'wall'), {
    text: 'x + wall',
    caret: 8,
  });
});

void test('arrow keys wrap; parameter candidates carry value and unit', () => {
  assert.equal(moveActive(-1, 3, 'ArrowDown'), 0);
  assert.equal(moveActive(2, 3, 'ArrowDown'), 0);
  assert.equal(moveActive(0, 3, 'ArrowUp'), 2);
  assert.equal(moveActive(0, 0, 'ArrowDown'), -1);
  assert.deepEqual(
    parameterCandidates(
      [
        { name: 'wall', unit: 'mm', value: 3 },
        { name: 'tilt', unit: 'deg', value: 12.5 },
        { name: 'n', unit: '', value: 4 },
      ],
      'n',
    ),
    [
      { name: 'wall', detail: '3 mm' },
      { name: 'tilt', detail: '12.5°' },
    ],
  );
});
