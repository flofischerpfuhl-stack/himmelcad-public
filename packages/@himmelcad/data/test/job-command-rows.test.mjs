import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schema = JSON.parse(
  await readFile(new URL('../../../../schemas/automation/himmelcad-automation-v1.schema.json', import.meta.url)),
);

test('G-UIP-JOBS P11 rows use the S-01 operation envelope', () => {
  assert.deepEqual(
    ['jobs.list', 'jobs.get', 'jobs.cancel', 'jobs.respond'].map((name) => [name, schema.methods[name]]),
    [
      ['jobs.list', { capability: 'jobs.read', request: 'AdmissionOperationRequest', response: 'AdmissionOperationResult' }],
      ['jobs.get', { capability: 'jobs.read', request: 'AdmissionOperationRequest', response: 'AdmissionOperationResult' }],
      ['jobs.cancel', { capability: 'jobs.write', request: 'AdmissionOperationRequest', response: 'AdmissionOperationResult' }],
      ['jobs.respond', { capability: 'jobs.write', request: 'AdmissionOperationRequest', response: 'AdmissionOperationResult' }],
    ],
  );
});
