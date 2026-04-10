# Roster State Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daily roster selection resilient in GitHub Actions by removing persisted daily roster as an authority, spreading cold-start selection below full-roster fetches, and cooling down dormant accounts before they re-enter selection.

**Architecture:** Keep `account-score.json` as the durable state source for roster preparation. `prepareDailyRoster()` will rebuild `daily.csv` from score state every run, reuse same-day prepared selections from score-state metadata, and use deterministic cadence hashing for accounts without prior selection history. Dormant fetch outcomes will write a cooldown timestamp back into score state so future roster preparation can skip those accounts until they are eligible again.

**Tech Stack:** Node.js ESM, node:test, GitHub Actions workflow YAML

---

### Task 1: Lock failing roster behaviors with tests

**Files:**
- Modify: `test/roster.test.mjs`
- Modify: `test/roster.repeat.test.mjs`

- [ ] **Step 1: Write a failing cold-start staggering test**

```javascript
test('prepareDailyRoster staggers cold-start accounts instead of selecting the full roster', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-23',
    });

    assert.equal(summary.masterCount, 2);
    assert.equal(summary.dailyCount, 1);
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run the cold-start roster test and verify it fails**

Run: `node --test test/roster.test.mjs --test-name-pattern "staggers cold-start"`
Expected: FAIL because `prepareDailyRoster()` currently selects both seeds on first run.

- [ ] **Step 3: Write a failing same-day reuse-from-score-state test**

```javascript
test('prepareDailyRoster rebuilds the same-day roster from score state without relying on persisted daily csv', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    await writeFile(
      `${fixture.skillRoot}\\account-score.json`,
      JSON.stringify({
        meta: {
          lastPreparedRunDate: '2026-03-24',
          preparedSelectionKeys: ['handle:alice', 'handle:bob'],
        },
        accounts: [
          { handle: 'alice', userPageUrl: 'https://x.com/alice', score: 4, tier: 'daily', lastSelectedAt: '2026-03-24', selectionCount: 2, unseen: false },
          { handle: 'bob', userPageUrl: 'https://x.com/bob', score: 0, tier: 'cold', lastSelectedAt: '2026-03-24', selectionCount: 2, unseen: false },
        ],
      }, null, 2),
      'utf8',
    );

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-24',
    });

    assert.equal(summary.dailyCount, 2);
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 4: Run the same-day roster test and verify it fails**

Run: `node --test test/roster.repeat.test.mjs --test-name-pattern "rebuilds the same-day roster"`
Expected: FAIL because the current implementation requires `daily.csv` to exist for same-day reuse.

- [ ] **Step 5: Write a failing dormant cooldown test**

```javascript
test('prepareDailyRoster skips accounts whose dormant cooldown has not expired', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    await writeFile(
      `${fixture.skillRoot}\\account-score.json`,
      JSON.stringify({
        meta: {},
        accounts: [
          {
            sourceTweetId: '1599634054919245824',
            handle: 'alice',
            displayName: 'Alice Maker',
            userPageUrl: 'https://x.com/alice',
            score: 4,
            tier: 'daily',
            lastSelectedAt: '2026-03-23',
            selectionCount: 1,
            unseen: false,
          },
          {
            sourceTweetId: '1439790545048457225',
            handle: 'bob',
            displayName: 'Bob Chen',
            userPageUrl: 'https://x.com/bob',
            score: 2,
            tier: 'every_other_day',
            lastSelectedAt: '2026-03-22',
            selectionCount: 1,
            lastFetchStatus: 'dormant_skipped',
            nextEligibleAt: '2026-03-30',
            unseen: false,
          },
        ],
      }, null, 2),
      'utf8',
    );

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-24',
    });

    assert.equal(summary.dailyCount, 1);
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 6: Run the dormant cooldown test and verify it fails**

Run: `node --test test/roster.test.mjs --test-name-pattern "dormant cooldown"`
Expected: FAIL because the current roster selection ignores `nextEligibleAt`.

### Task 2: Rework durable roster state

**Files:**
- Modify: `scripts/roster.mjs`
- Test: `test/roster.test.mjs`
- Test: `test/roster.repeat.test.mjs`

- [ ] **Step 1: Add durable prepared-selection metadata and deterministic cold-start staggering**

```javascript
function buildAccountStateKey(entry) {
  const handle = String(entry?.handle ?? '').trim().toLowerCase();
  if (handle) return `handle:${handle}`;
  const userPageUrl = String(entry?.userPageUrl ?? '').trim().toLowerCase();
  if (userPageUrl) return `url:${userPageUrl}`;
  const sourceTweetId = String(entry?.sourceTweetId ?? '').trim();
  return sourceTweetId ? `tweet:${sourceTweetId}` : null;
}
```

- [ ] **Step 2: Keep same-day reuse inside `account-score.json`, not `daily.csv`**

```javascript
scoreState.meta = {
  ...(scoreState.meta ?? {}),
  lastPreparedRunDate: runDate,
  preparedSelectionKeys,
  dailyCount: dailyRows.length,
};
```

- [ ] **Step 3: Make roster selection skip dormant cooldown accounts and use deterministic cadence for unselected accounts**

```javascript
if (entry.nextEligibleAt && daysBetweenDates(runDate, entry.nextEligibleAt) < 0) {
  continue;
}
if (!entry.lastSelectedAt) {
  if (isSelectedByCadenceHash(entry, runDate, rosterConfig)) selected.push(entry);
  continue;
}
```

- [ ] **Step 4: Run roster tests until all changed cases pass**

Run: `node --test test/roster.test.mjs test/roster.repeat.test.mjs`
Expected: PASS

### Task 3: Persist dormant cooldown from fetch outcomes

**Files:**
- Modify: `scripts/roster.mjs`
- Test: `test/roster.test.mjs`

- [ ] **Step 1: Write a failing score-state cooldown persistence test**

```javascript
test('runRosterScoring stores dormant cooldown metadata for dormant accounts', async () => {
  // Prepare score state, pass fetchResult with bob.status = 'dormant_skipped',
  // then assert nextEligibleAt is written seven days forward.
});
```

- [ ] **Step 2: Run the score-state cooldown test and verify it fails**

Run: `node --test test/roster.test.mjs --test-name-pattern "stores dormant cooldown"`
Expected: FAIL because `applyScoringDecisions()` currently never writes cooldown metadata.

- [ ] **Step 3: Implement dormant cooldown persistence in `applyScoringDecisions()`**

```javascript
if (account.status === 'dormant_skipped') {
  entry.nextEligibleAt = addDays(runDate, rosterConfig.dormantCooldownDays);
} else {
  entry.nextEligibleAt = null;
}
```

- [ ] **Step 4: Run the roster tests again**

Run: `node --test test/roster.test.mjs test/roster.repeat.test.mjs`
Expected: PASS

### Task 4: Simplify workflow state persistence and expose roster observability

**Files:**
- Modify: `.github/workflows/daily-report.yml`

- [ ] **Step 1: Stop downloading and uploading persisted `X列表关注者.daily.csv`**

```yaml
- aws --endpoint-url "${R2_ENDPOINT}" s3 cp "s3://${R2_BUCKET_NAME}/state/X列表关注者.daily.csv" "./X列表关注者.daily.csv" || echo "..."
```

Remove the download/upload lines for `X列表关注者.daily.csv`.

- [ ] **Step 2: Print roster summary from `run-summary.json` into Actions logs**

```bash
node --input-type=module - <<'EOF'
import { readFileSync } from 'node:fs';
const summary = JSON.parse(readFileSync('.tmp/github-actions/run-summary.json', 'utf8'));
console.log(JSON.stringify(summary.roster ?? null, null, 2));
EOF
```

- [ ] **Step 3: Run targeted tests plus workflow sanity checks**

Run: `node --test test/run.test.mjs test/roster.test.mjs test/roster.repeat.test.mjs test/fetch.workflow.test.mjs`
Expected: PASS
