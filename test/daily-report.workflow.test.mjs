import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function readUtf8(relativePath) {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function extractFinalDraftGateScript(workflow) {
  const gateStart = workflow.indexOf('- name: Flag degraded final draft');
  assert.notEqual(gateStart, -1);
  const gateWorkflow = workflow.slice(gateStart);
  const scriptMatch = gateWorkflow.match(/node --input-type=module - <<'EOF'\r?\n([\s\S]*?)\r?\n\s+EOF/);
  assert.ok(scriptMatch, 'final draft gate script should be present');
  return scriptMatch[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
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

test('daily-report workflow fails when final draft uses fallback model', async () => {
  const workflow = await readUtf8('../.github/workflows/daily-report.yml');
  const script = extractFinalDraftGateScript(workflow);
  const tempDir = await mkdtemp(join(tmpdir(), 'x-monitor-gate-'));
  try {
    await mkdir(join(tempDir, '.tmp', 'github-actions'), { recursive: true });
    await writeFile(
      join(tempDir, '.tmp', 'github-actions', 'run-summary.json'),
      JSON.stringify({ analyze: { answerSource: 'fallback_model' } }),
    );

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /终稿降级/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('daily-report gate keeps fallback_model accurate when primary hit a 401', async () => {
  const workflow = await readUtf8('../.github/workflows/daily-report.yml');
  const script = extractFinalDraftGateScript(workflow);
  const tempDir = await mkdtemp(join(tmpdir(), 'x-monitor-gate-'));
  try {
    await mkdir(join(tempDir, '.tmp', 'github-actions'), { recursive: true });
    await writeFile(
      join(tempDir, '.tmp', 'github-actions', 'run-summary.json'),
      JSON.stringify({
        analyze: {
          answerSource: 'fallback_model',
          finalDraftDegraded: true,
          modelAvailabilityIssue: '401 Invalid API key，请检查模型可用性',
        },
      }),
    );

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    // primary 401 但 fallback 成功出稿：仍以退出码标红降级，
    // 但消息必须准确反映“fallback 生成”，不得误报“终稿模型不可用”。
    assert.equal(result.status, 1);
    assert.match(result.stdout, /本稿由 fallback 模型生成/);
    assert.match(result.stdout, /401 Invalid API key/);
    assert.doesNotMatch(result.stdout, /终稿模型不可用/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
