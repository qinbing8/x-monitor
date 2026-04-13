import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function readUtf8(relativePath) {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

test('daily-report workflow keeps live fetch overrides bounded for GitHub Actions', async () => {
  const workflow = await readUtf8('../.github/workflows/daily-report.yml');

  assert.match(workflow, /fetchProfile\.timeoutMs = 100000;/);
  assert.match(workflow, /fetchProfile\.batchSize = 1;/);
  assert.match(workflow, /fetchProfile\.concurrency = 5;/);
  assert.match(workflow, /fetchProfile\.refetchBatchSize = 1;/);
  assert.match(workflow, /fetchProfile\.refetchConcurrency = 5;/);
});
