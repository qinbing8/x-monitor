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
  assert.match(workflow, /fetchProfile\.concurrency = 1;/);
  assert.match(workflow, /fetchProfile\.requestMinIntervalMs = 3500;/);
  assert.match(workflow, /fetchProfile\.refetchBatchSize = 1;/);
  assert.match(workflow, /fetchProfile\.refetchConcurrency = 1;/);
});

test('daily-report workflow wires independent fallback brief model secrets into runtime config', async () => {
  const workflow = await readUtf8('../.github/workflows/daily-report.yml');

  assert.match(workflow, /OPENAI_BRIEF_FALLBACK_MODEL: \$\{\{ secrets\.OPENAI_BRIEF_FALLBACK_MODEL \}\}/);
  assert.match(workflow, /Using OPENAI_BRIEF_FALLBACK_RUNTIME_MODEL=/);
  assert.match(workflow, /'gpt-brief-fallback': \{/);
  assert.match(workflow, /briefFallbackModelRef = 'gpt-brief-fallback';/);
});

test('daily-report workflow defaults lower-cost GPT stages unless secrets override them', async () => {
  const workflow = await readUtf8('../.github/workflows/daily-report.yml');

  assert.match(workflow, /reasoningEffort: 'high'/);
  assert.match(workflow, /Using OPENAI_SCREENING_RUNTIME_MODEL=/);
  assert.match(workflow, /Using OPENAI_ROSTER_RUNTIME_MODEL=/);
  assert.match(workflow, /OPENAI_BRIEF_FALLBACK_MODEL \?\? ''\)\.trim\(\) \|\| 'gpt-5\.4-mini'/);
  assert.match(workflow, /OPENAI_SCREENING_MODEL \?\? ''\)\.trim\(\) \|\| 'gpt-5\.4-mini'/);
  assert.match(workflow, /OPENAI_ROSTER_MODEL \?\? ''\)\.trim\(\) \|\| 'gpt-5\.4-mini'/);
});
