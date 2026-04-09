import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureRunDir, resolveRunDate } from '../scripts/artifact-store.mjs';

test('resolveRunDate accepts ISO day strings and defaults to a valid current day', () => {
  assert.equal(resolveRunDate('2026-03-28'), '2026-03-28');
  assert.match(resolveRunDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('resolveRunDate rejects invalid values instead of emitting NaN dates', () => {
  assert.throws(() => resolveRunDate('NaN-NaN-NaN'), /Invalid run date/);
  assert.throws(() => resolveRunDate(new Date('invalid')), /Invalid run date/);
});

test('ensureRunDir creates distinct run directories for rapid consecutive calls', async () => {
  const skillRoot = await mkdtemp(join(tmpdir(), 'x-monitor-artifact-store-'));
  try {
    const first = await ensureRunDir(skillRoot, 'data', '2026-03-28');
    const second = await ensureRunDir(skillRoot, 'data', '2026-03-28');

    assert.notEqual(first, second);
  } finally {
    await rm(skillRoot, { recursive: true, force: true });
  }
});
