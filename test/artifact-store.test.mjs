import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveRunDate,
  ensureRunDir,
  findLatestRunDir,
  writeJsonArtifact,
  writeTextArtifact,
  readJsonArtifact,
} from '../scripts/artifact-store.mjs';

test('resolveRunDate normalizes Date and string inputs', () => {
  assert.equal(resolveRunDate('2026-03-23'), '2026-03-23');
  assert.equal(resolveRunDate(new Date('2026-03-24T12:30:00Z')), '2026-03-24');
});

test('ensureRunDir and artifact helpers create and round-trip files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'x-monitor-artifacts-'));
  try {
    const runDir = await ensureRunDir(root, './data', '2026-03-23');
    assert.match(runDir, /run-\d{6}$/);

    const jsonPath = await writeJsonArtifact(runDir, 'sample.json', { ok: true });
    const textPath = await writeTextArtifact(runDir, 'sample.txt', 'hello');

    assert.equal((await readJsonArtifact(runDir, 'sample.json')).ok, true);
    assert.equal(textPath.endsWith('sample.txt'), true);
    assert.equal(jsonPath.endsWith('sample.json'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findLatestRunDir returns latest run folder or date folder when empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'x-monitor-runs-'));
  try {
    const dateDir = join(root, 'data', '2026-03-23');
    await mkdir(join(dateDir, 'run-010101'), { recursive: true });
    await mkdir(join(dateDir, 'run-235959'), { recursive: true });

    assert.equal(
      await findLatestRunDir(root, './data', '2026-03-23'),
      join(dateDir, 'run-235959'),
    );
    assert.equal(
      await findLatestRunDir(root, './data', '2026-03-24'),
      join(root, 'data', '2026-03-24'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
