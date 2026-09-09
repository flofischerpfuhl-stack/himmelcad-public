import assert from 'node:assert/strict';
import test from 'node:test';

import {
  registrationCancellationIsAlreadyComplete,
  registrationCancellationOutcomeIsComplete,
} from '../electron/registrationCancellation.js';

test('needs-input imports cancel cleanly before a sidecar session exists', () => {
  assert.equal(
    registrationCancellationIsAlreadyComplete(new Error('registration session is unknown')),
    true,
  );
  assert.equal(
    registrationCancellationIsAlreadyComplete(new Error('no canonical project is open')),
    true,
  );
  assert.equal(registrationCancellationIsAlreadyComplete(new Error('worker did not stop')), false);
});

test('a missing pre-stage session is an immediately complete cancellation outcome', () => {
  assert.equal(registrationCancellationOutcomeIsComplete({}), true);
  assert.equal(
    registrationCancellationOutcomeIsComplete({ cancellationRequested: true }),
    false,
  );
});
