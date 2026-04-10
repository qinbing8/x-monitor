import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { prepareDailyRoster } from '../scripts/roster.mjs';
import { createMockSkillFixture, readJson, readText } from '../support/fixtures.mjs';

function withRosterConfig(config) {
  return {
    ...config,
    fetch: {
      ...config.fetch,
      profiles: {
        ...config.fetch.profiles,
        'grok-default': {
          ...config.fetch.profiles['grok-default'],
          seedCsvPath: './daily.csv',
        },
      },
    },
    roster: {
      enabled: true,
      masterCsvPath: './seed.csv',
      dailyCsvPath: './daily.csv',
      scoreFilePath: './account-score.json',
      dormantCooldownDays: 7,
      scoring: {
        enabled: true,
        promptFile: './assets/prompts/gpt-roster-score.txt',
        batchSize: 10,
        maxTweetsPerAccount: 3,
        defaultScore: 2,
        minScore: 0,
        maxScore: 5,
        dailyMinScore: 4,
        everyOtherDayMinScore: 2,
        weeklyMinScore: 1,
        dailyIntervalDays: 1,
        everyOtherDayIntervalDays: 2,
        weeklyIntervalDays: 7,
        coldIntervalDays: 28,
      },
    },
  };
}

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
          dailyCount: 2,
          preparedSelectionKeys: ['handle:alice', 'handle:bob'],
        },
        accounts: [
          {
            sourceTweetId: '1599634054919245824',
            handle: 'alice',
            displayName: 'Alice Maker',
            userPageUrl: 'https://x.com/alice',
            postCount: 12,
            score: 4,
            tier: 'daily',
            lastEvaluatedAt: '2026-03-24T00:00:00Z',
            lastSelectedAt: '2026-03-24',
            lastFetchStatus: 'covered',
            highValueHitCount: 2,
            lowValueChatCount: 0,
            evaluationCount: 2,
            selectionCount: 2,
            reasoning: 'Useful tool updates.',
            unseen: false,
          },
          {
            sourceTweetId: '1439790545048457225',
            handle: 'bob',
            displayName: 'Bob Chen',
            userPageUrl: 'https://x.com/bob',
            postCount: 0,
            score: 0,
            tier: 'cold',
            lastEvaluatedAt: '2026-03-24T00:00:00Z',
            lastSelectedAt: '2026-03-24',
            lastFetchStatus: 'no_tweets_found',
            highValueHitCount: 0,
            lowValueChatCount: 3,
            evaluationCount: 2,
            selectionCount: 2,
            reasoning: 'Mostly casual chatter.',
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

    assert.equal(summary.dailyCount, 2);
    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.match(dailyCsv, /"alice"/);
    assert.match(dailyCsv, /"bob"/);

    const scoreState = await readJson(summary.scoreFilePath);
    const alice = scoreState.accounts.find((entry) => entry.handle === 'alice');
    const bob = scoreState.accounts.find((entry) => entry.handle === 'bob');
    assert.equal(scoreState.meta.lastPreparedRunDate, '2026-03-24');
    assert.deepEqual(scoreState.meta.preparedSelectionKeys, ['handle:alice', 'handle:bob']);
    assert.equal(alice.selectionCount, 2);
    assert.equal(bob.selectionCount, 2);
    assert.equal(alice.lastSelectedAt, '2026-03-24');
    assert.equal(bob.lastSelectedAt, '2026-03-24');
  } finally {
    await fixture.cleanup();
  }
});

test('prepareDailyRoster does not reuse stale daily roster when only lastScoredRunDate matches', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const staleDailyCsv = [
      'TweetID,UserPageURL,Handle,Name,PostCount',
      '"legacy","https://x.com/legacy","legacy","Legacy User","1"',
    ].join('\n');
    await writeFile(`${fixture.skillRoot}\\daily.csv`, staleDailyCsv, 'utf8');
    await writeFile(
      `${fixture.skillRoot}\\account-score.json`,
      JSON.stringify({
        meta: {
          lastScoredRunDate: '2026-03-24',
        },
        accounts: [],
      }, null, 2),
      'utf8',
    );

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-24',
    });

    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.notEqual(dailyCsv, staleDailyCsv);
    assert.match(dailyCsv, /("alice"|"bob")/);
    assert.equal(summary.dailyCount, 1);

    const scoreState = await readJson(summary.scoreFilePath);
    assert.equal(scoreState.meta.lastPreparedRunDate, '2026-03-24');
  } finally {
    await fixture.cleanup();
  }
});
