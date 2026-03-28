import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRunDate } from '../scripts/artifact-store.mjs';

test('resolveRunDate accepts ISO day strings and defaults to a valid current day', () => {
  assert.equal(resolveRunDate('2026-03-28'), '2026-03-28');
  assert.match(resolveRunDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('resolveRunDate rejects invalid values instead of emitting NaN dates', () => {
  assert.throws(() => resolveRunDate('NaN-NaN-NaN'), /Invalid run date/);
  assert.throws(() => resolveRunDate(new Date('invalid')), /Invalid run date/);
});
