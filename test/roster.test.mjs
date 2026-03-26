import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { loadConfig, loadSourceDocuments } from '../scripts/config-loader.mjs';
import { resolveAnalysisProfile } from '../scripts/provider-resolver.mjs';
import { runFetch } from '../scripts/fetch.mjs';
import { prepareDailyRoster, runRosterScoring } from '../scripts/roster.mjs';
import {
  FIXTURE_REFERENCE_TIME,
  FIXTURE_TWEET_FETCH_RESPONSE,
  createCompletionFetch,
  createMockSkillFixture,
  readJson,
  readText,
} from '../support/fixtures.mjs';

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

test('prepareDailyRoster bootstraps a daily roster and score state from the master roster', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-23',
    });

    assert.equal(summary.masterCount, 2);
    assert.equal(summary.dailyCount, 2);

    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.match(dailyCsv, /UserPageURL,Handle,Name,PostCount/);
    assert.match(dailyCsv, /https:\/\/x\.com\/alice/);
    assert.match(dailyCsv, /https:\/\/x\.com\/bob/);

    const scoreState = await readJson(summary.scoreFilePath);
    assert.equal(scoreState.accounts.length, 2);
    assert.equal(scoreState.accounts[0].score, 2);
    assert.equal(scoreState.accounts[0].tier, 'every_other_day');
    assert.equal(scoreState.accounts[0].lastSelectedAt, '2026-03-23');
  } finally {
    await fixture.cleanup();
  }
});

test('prepareDailyRoster respects cadence tiers when selecting the next daily roster', async () => {
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
            handle: 'alice',
            displayName: 'Alice Maker',
            userPageUrl: 'https://x.com/alice',
            postCount: 12,
            score: 4,
            tier: 'daily',
            lastEvaluatedAt: '2026-03-23T00:00:00Z',
            lastSelectedAt: '2026-03-23',
            lastFetchStatus: 'covered',
            highValueHitCount: 1,
            lowValueChatCount: 0,
            evaluationCount: 1,
            selectionCount: 1,
            reasoning: 'Useful tool updates.',
            unseen: false,
          },
          {
            handle: 'bob',
            displayName: 'Bob Chen',
            userPageUrl: 'https://x.com/bob',
            postCount: 0,
            score: 0,
            tier: 'cold',
            lastEvaluatedAt: '2026-03-23T00:00:00Z',
            lastSelectedAt: '2026-03-23',
            lastFetchStatus: 'no_tweets_found',
            highValueHitCount: 0,
            lowValueChatCount: 3,
            evaluationCount: 1,
            selectionCount: 1,
            reasoning: 'Mostly casual chatter.',
            unseen: false,
          },
        ],
      }, null, 2),
    );

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-24',
    });

    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.match(dailyCsv, /alice/);
    assert.doesNotMatch(dailyCsv, /bob/);
    assert.equal(summary.dailyCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('runRosterScoring updates account scores from GPT decisions without changing Grok fetch behavior', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-23',
    });

    const fetchSummary = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const { config: loadedConfig, skillRoot } = await loadConfig(fixture.configPath);
    const sourceDocs = await loadSourceDocuments(loadedConfig, skillRoot);
    const profile = resolveAnalysisProfile(loadedConfig, sourceDocs, 'gpt-default');
    const fetchResult = await readJson(fetchSummary.fetchResultPath);
    const scoringResponse = JSON.stringify([
      {
        handle: 'alice',
        high_value_tweet_count: 1,
        low_value_chat_count: 0,
        reason: 'Concrete tooling updates with usable links.',
      },
    ], null, 2);

    const summary = await runRosterScoring({
      config: loadedConfig,
      skillRoot,
      runDate: '2026-03-23',
      fetchResult,
      profile,
      fetchImpl: createCompletionFetch(scoringResponse),
      runDir: fetchSummary.runDir,
    });

    assert.equal(summary.scoredAccountCount, 1);

    const scoreState = await readJson(summary.scoreFilePath);
    const alice = scoreState.accounts.find((entry) => entry.handle === 'alice');
    const bob = scoreState.accounts.find((entry) => entry.handle === 'bob');
    assert.equal(alice.score, 4);
    assert.equal(alice.tier, 'daily');
    assert.match(alice.reasoning, /Concrete tooling updates/);
    assert.equal(bob.score, 2);
    assert.equal(bob.lastFetchStatus, 'no_tweets_found');

    const scoreResult = await readJson(summary.rosterScoreResultPath);
    assert.equal(scoreResult.decisionCount, 1);
    assert.equal(scoreResult.decisions[0].handle, 'alice');
  } finally {
    await fixture.cleanup();
  }
});
