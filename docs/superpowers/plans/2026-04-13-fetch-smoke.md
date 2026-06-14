# Fetch Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个独立的 `fetch-smoke` GitHub Actions workflow，只跑真实 Grok fetch，并输出模型选择、timeout、HTTP 500 与抓取结果摘要。

**Architecture:** 复用 `daily-report.yml` 里已经存在的 `GROK_RUNTIME_MODEL` 探测逻辑，生成一份仅用于 smoke 的临时配置和 3 账号 probe CSV。workflow 只调用 `node scripts/run.mjs --mode fetch`，随后从 fetch 产物中汇总诊断 JSON，并上传 fetch artifacts；不进入 analyze、publish、deploy。

**Tech Stack:** GitHub Actions YAML, Node.js 22, 仓库现有 `scripts/run.mjs`, Node test runner (`node --test`)

---

## File Map

- Create: `.github/workflows/fetch-smoke.yml`
  - 独立的 smoke workflow，负责模型探测、生成临时配置与 probe CSV、执行 fetch、打印摘要、上传 artifacts。
- Create: `test/fetch-smoke.workflow.test.mjs`
  - workflow 回归测试，锁定 smoke workflow 的关键约束，避免后续改动把诊断流重新污染成 full pipeline。
- Reuse only: `.github/workflows/daily-report.yml`
  - 作为 `GROK_RUNTIME_MODEL` 探测逻辑和 GitHub Actions 环境变量组织方式的参考，不做修改。
- Reuse only: `config.example.json`
  - 作为生成 `config.fetch-smoke.generated.json` 的模板来源，不做修改。

### Task 1: Lock Workflow Contract With A Failing Test

**Files:**
- Create: `test/fetch-smoke.workflow.test.mjs`
- Reference: `.github/workflows/daily-report.yml`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function readUtf8(relativePath) {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

test('fetch-smoke workflow keeps Grok smoke diagnostics isolated from daily-report', async () => {
  const workflow = await readUtf8('../.github/workflows/fetch-smoke.yml');

  assert.match(workflow, /name:\s+fetch-smoke/);
  assert.match(workflow, /GROK_RUNTIME_MODEL/);
  assert.match(workflow, /node scripts\/run\.mjs --mode fetch/);
  assert.match(workflow, /fetchProfile\.batchSize = 1;/);
  assert.match(workflow, /fetchProfile\.concurrency = 1;/);
  assert.match(workflow, /fetchProfile\.timeoutMs = 75000;/);
  assert.match(workflow, /fetchProfile\.refetchMaxRounds = 0;/);
  assert.match(workflow, /fetch-smoke\.csv/);
  assert.doesNotMatch(workflow, /scripts\/publish-report\.mjs/);
  assert.doesNotMatch(workflow, /Deploy Cloudflare Worker/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test --test-isolation=none test\fetch-smoke.workflow.test.mjs
```

Expected:

```text
FAIL
... Cannot find .../.github/workflows/fetch-smoke.yml ...
```

- [ ] **Step 3: Add the smallest possible workflow shell**

Create `.github/workflows/fetch-smoke.yml` with only the structural minimum needed to satisfy the file existence and top-level workflow name assertions first:

```yaml
name: fetch-smoke

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  fetch-smoke:
    runs-on: ubuntu-latest
    steps:
      - name: Placeholder
        run: echo "fetch smoke placeholder"
```

- [ ] **Step 4: Re-run the single test and confirm it still fails on missing workflow content**

Run:

```powershell
node --test --test-isolation=none test\fetch-smoke.workflow.test.mjs
```

Expected:

```text
FAIL
... expected workflow to contain GROK_RUNTIME_MODEL / --mode fetch / fetchProfile overrides ...
```

- [ ] **Step 5: Commit the red test scaffold**

```powershell
git add -- test/fetch-smoke.workflow.test.mjs .github/workflows/fetch-smoke.yml
git commit -m "test(fetch-smoke): 锁定冒烟工作流约束"
```

### Task 2: Implement The Real Fetch-Smoke Workflow

**Files:**
- Modify: `.github/workflows/fetch-smoke.yml`
- Verify against: `test/fetch-smoke.workflow.test.mjs`

- [ ] **Step 1: Replace the placeholder with the real workflow structure**

Use the same secret/env layout as `daily-report.yml`, but keep only Grok-related variables:

```yaml
name: fetch-smoke

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  fetch-smoke:
    runs-on: ubuntu-latest
    env:
      TZ: Asia/Shanghai
      GROK_API_KEY: ${{ secrets.GROK_API_KEY }}
      GROK_BASE_URL: ${{ secrets.GROK_BASE_URL }}
      GROK_MODEL: ${{ secrets.GROK_MODEL }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 22
```

- [ ] **Step 2: Add the Grok runtime model probe step**

Embed the same probing logic shape already used in `daily-report.yml`, and persist the chosen model for both later commands in this step and later workflow steps:

```yaml
      - name: Prepare fetch-smoke runtime files
        shell: bash
        run: |
          mkdir -p .tmp/github-actions
          GROK_RUNTIME_MODEL="$(node --input-type=module - <<'EOF'
          const fallbackModel = 'grok-4.1-fast';
          const requestedModel = String(process.env.GROK_MODEL ?? '').trim();
          const apiKey = String(process.env.GROK_API_KEY ?? '').trim();
          const rawBaseUrl = String(process.env.GROK_BASE_URL ?? '').trim();
          // Keep normalizeBaseUrl / unique / resolveGrokModel aligned with daily-report.yml.
          EOF
          )"
          export GROK_RUNTIME_MODEL
          if [ -n "${GITHUB_ENV:-}" ]; then
            printf 'GROK_RUNTIME_MODEL=%s\n' "${GROK_RUNTIME_MODEL}" >> "${GITHUB_ENV}"
          fi
          echo "Using GROK_RUNTIME_MODEL=${GROK_RUNTIME_MODEL}"
```

- [ ] **Step 3: Generate the 3-account probe CSV and smoke config**

Append the runtime step with explicit serial overrides and a fixed temporary CSV. Use Node to write CSV/JSON files instead of shell heredocs to avoid YAML indentation polluting CSV columns and to safely escape any special characters (`"`, `\`, `&`) in env values. The previous step must export `GROK_RUNTIME_MODEL`; otherwise this Node process will write an empty model into `search.json`:

```yaml
          node --input-type=module - <<'EOF'
          import { writeFileSync } from 'node:fs';

          const csvLines = [
            'handle,displayName,userPageUrl,followersCount,postCount,totalFavouritesByUser,isBlueVerified,verified',
            'openai,OpenAI,https://x.com/openai,0,1,0,false,false',
            'anthropicai,Anthropic,https://x.com/AnthropicAI,0,1,0,false,false',
            'Grok,GroK,https://x.com/grok,0,1,0,false,false',
          ];
          writeFileSync('.tmp/github-actions/fetch-smoke.csv', csvLines.join('\n') + '\n');

          const searchCredentials = {
            grok: {
              apiUrl: process.env.GROK_BASE_URL ?? '',
              apiKey: process.env.GROK_API_KEY ?? '',
              model: process.env.GROK_RUNTIME_MODEL ?? '',
            },
          };
          writeFileSync('.tmp/github-actions/search.json', JSON.stringify(searchCredentials, null, 2));
          writeFileSync('.tmp/github-actions/openclaw.json', JSON.stringify({}, null, 2));
          EOF

          node --input-type=module - <<'EOF'
          import { readFileSync, writeFileSync } from 'node:fs';

          const config = JSON.parse(readFileSync('config.example.json', 'utf8'));
          config.sources.credentialFiles = {
            search: './.tmp/github-actions/search.json',
            openclaw: './.tmp/github-actions/openclaw.json',
          };
          config.runtime.pipeline = ['fetch'];
          const fetchProfile = config.fetch?.profiles?.['grok-default'];
          fetchProfile.timeoutMs = 75000;
          fetchProfile.batchSize = 1;
          fetchProfile.concurrency = 1;
          fetchProfile.retry = { ...(fetchProfile.retry ?? {}), maxAttempts: 1, backoffMs: 3000 };
          fetchProfile.refetchMaxRounds = 0;
          fetchProfile.refetchBatchSize = 1;
          fetchProfile.refetchConcurrency = 1;
          writeFileSync('config.fetch-smoke.generated.json', JSON.stringify(config, null, 2));
          EOF
```

Note: `openclaw.json` is written as `{}` because `--mode fetch` does not invoke analysis; the config loader only checks that every declared credential file path exists.

- [ ] **Step 4: Run fetch-only and collect diagnostic JSON**

Add the smoke execution and summary steps:

```yaml
      - name: Run fetch smoke
        shell: bash
        run: |
          node scripts/run.mjs \
            --mode fetch \
            --config ./config.fetch-smoke.generated.json \
            --seed-csv ./.tmp/github-actions/fetch-smoke.csv \
            --skip-precheck > .tmp/github-actions/fetch-smoke-summary.json

      - name: Print fetch smoke diagnosis
        shell: bash
        run: |
          node --input-type=module - <<'EOF'
          import { readFileSync } from 'node:fs';

          const summary = JSON.parse(readFileSync('.tmp/github-actions/fetch-smoke-summary.json', 'utf8'));
          const fetchResult = JSON.parse(readFileSync(summary.fetch.fetchResultPath, 'utf8'));
          const fetchRaw = JSON.parse(readFileSync(summary.fetch.fetchRawPath, 'utf8'));
          const batches = Array.isArray(fetchRaw.batches) ? fetchRaw.batches : [];

          const timeoutCount = batches.filter((batch) => batch?.diagnostics?.classification === 'timeout').length;
          const http500Count = batches.filter((batch) => Number(batch?.diagnostics?.httpStatus) === 500).length;
          const payload = {
            requestedModel: process.env.GROK_MODEL ?? '',
            chosenModel: process.env.GROK_RUNTIME_MODEL ?? '',
            baseUrlHost: new URL(process.env.GROK_BASE_URL).host,
            seedCount: summary.fetch.seedCount,
            durationMs: summary.fetch.durationMs,
            tweetCount: fetchResult?.meta?.tweetCount ?? 0,
            coveredAccountCount: fetchResult?.meta?.coveredAccountCount ?? 0,
            warningCount: fetchResult?.meta?.warningCount ?? 0,
            timeoutCount,
            http500Count,
          };
          console.log(JSON.stringify(payload, null, 2));
          if (!payload.chosenModel || payload.timeoutCount + payload.http500Count >= 2 || (payload.tweetCount === 0 && payload.coveredAccountCount === 0)) {
            process.exitCode = 1;
          }
          EOF
```

- [ ] **Step 5: Upload artifacts and finish the green pass**

Add an artifact upload step that always runs:

```yaml
      - name: Upload fetch smoke artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: fetch-smoke-artifacts
          path: |
            .tmp/github-actions/fetch-smoke-summary.json
            data/**/fetch.input.json
            data/**/fetch.raw.json
            data/**/fetch.raw.csv
            data/**/fetch.tweet-index.csv
            data/**/fetch.result.json
```

- [ ] **Step 6: Run the workflow test and confirm it passes**

Run:

```powershell
node --test --test-isolation=none test\fetch-smoke.workflow.test.mjs
```

Expected:

```text
1 pass / 0 fail
```

- [ ] **Step 7: Run the related workflow tests as a regression set**

Run:

```powershell
node --test --test-isolation=none test\fetch-smoke.workflow.test.mjs test\daily-report.workflow.test.mjs
```

Expected:

```text
2 pass / 0 fail
```

- [ ] **Step 8: Commit the green implementation**

```powershell
git add -- .github/workflows/fetch-smoke.yml test/fetch-smoke.workflow.test.mjs
git commit -m "feat(fetch-smoke): 新增串行抓取冒烟工作流"
```

### Task 3: Verify End-To-End In GitHub Actions

**Files:**
- Reuse: `.github/workflows/fetch-smoke.yml`
- Inspect: uploaded workflow logs and artifacts

- [ ] **Step 1: Push the implementation branch**

```powershell
git push origin master
```

- [ ] **Step 2: Trigger the new smoke workflow**

```powershell
gh workflow run fetch-smoke.yml --ref master
```

- [ ] **Step 3: Watch the run to completion**

```powershell
gh run list --workflow fetch-smoke.yml --limit 1
gh run watch <run-id> --interval 15
```

Expected:

```text
completed success
```

or, if the chain is unhealthy, a deliberate failure with the diagnostic JSON printed near the end.

- [ ] **Step 4: Review the diagnostic output**

Confirm the workflow prints a JSON object containing:

```json
{
  "requestedModel": "grok-4.20-fast",
  "chosenModel": "grok-4.20-fast",
  "baseUrlHost": "example.gateway",
  "seedCount": 3,
  "durationMs": 12345,
  "tweetCount": 4,
  "coveredAccountCount": 2,
  "warningCount": 1,
  "timeoutCount": 0,
  "http500Count": 0
}
```

- [ ] **Step 5: If the run fails, classify the failure before any further code change**

Use the JSON plus raw artifacts to assign the issue to one of:

- `model selection`
- `gateway / relay instability`
- `provider timeout`
- `zero-data / coverage issue`

Do not modify code again until the failure is classified.

## Self-Review

- Spec coverage: plan covers the new standalone workflow, 3-account probe CSV, serial fetch-only config, diagnostic JSON output, failure gate, uploaded artifacts, and workflow-level regression test.
- Placeholder scan: no `TBD` / `TODO`; all files, commands, and assertions are named explicitly.
- Type consistency: the plan consistently uses `fetch-smoke.yml`, `test/fetch-smoke.workflow.test.mjs`, `GROK_RUNTIME_MODEL`, `fetch-smoke.csv`, `config.fetch-smoke.generated.json`, and `fetch-smoke-summary.json`.
