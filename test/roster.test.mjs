import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
      dormantCooldownDays: 7,
      minDailyRosterSize: 1,
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

    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.match(dailyCsv, /TweetID,UserPageURL,Handle,Name,PostCount/);
    assert.match(dailyCsv, /(https:\/\/x\.com\/alice|https:\/\/x\.com\/bob)/);

    const scoreState = await readJson(summary.scoreFilePath);
    assert.equal(scoreState.accounts.length, 2);
    assert.equal(scoreState.accounts[0].score, 2);
    assert.equal(scoreState.accounts[0].tier, 'every_other_day');
    assert.equal(scoreState.accounts[1].tier, 'every_other_day');
    assert.equal(scoreState.meta.selectionStrategy, 'cadence_hash_v2_topup_floor');
    const selectedEntries = scoreState.accounts.filter((entry) => entry.lastSelectedAt === '2026-03-23');
    assert.equal(selectedEntries.length, 1);
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
            sourceTweetId: '1599634054919245824',
            handle: 'alice_legacy_handle',
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
            sourceTweetId: '1439790545048457225',
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
    assert.match(dailyCsv, /1599634054919245824/);
    assert.match(dailyCsv, /alice/);
    assert.doesNotMatch(dailyCsv, /bob/);
    assert.equal(summary.dailyCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('prepareDailyRoster heals invalid stored selection dates and still shrinks the roster', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    await writeFile(
      `${fixture.skillRoot}\\account-score.json`,
      JSON.stringify({
        meta: {
          lastPreparedRunDate: 'NaN-NaN-NaN',
          lastScoredRunDate: '2026-03-23',
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
            lastEvaluatedAt: '2026-03-23T00:00:00Z',
            lastSelectedAt: 'NaN-NaN-NaN',
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
            lastEvaluatedAt: '2026-03-23T00:00:00Z',
            lastSelectedAt: 'NaN-NaN-NaN',
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
    );

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-24',
    });

    assert.equal(summary.dailyCount, 1);

    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.match(dailyCsv, /alice/);
    assert.doesNotMatch(dailyCsv, /bob/);

    const scoreState = await readJson(summary.scoreFilePath);
    const alice = scoreState.accounts.find((entry) => entry.handle === 'alice');
    const bob = scoreState.accounts.find((entry) => entry.handle === 'bob');
    assert.equal(scoreState.meta.lastPreparedRunDate, '2026-03-24');
    assert.equal(alice.lastSelectedAt, '2026-03-24');
    assert.equal(bob.lastSelectedAt, null);
  } finally {
    await fixture.cleanup();
  }
});

test('prepareDailyRoster ignores legacy lastScoredRunDate as selection proof when lastSelectedAt is missing', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    await writeFile(
      `${fixture.skillRoot}\\account-score.json`,
      JSON.stringify({
        meta: {
          lastScoredRunDate: '2026-03-23',
        },
        accounts: [
          {
            sourceTweetId: '1599634054919245824',
            handle: 'alice',
            displayName: 'Alice Maker',
            userPageUrl: 'https://x.com/alice',
            postCount: 12,
            score: 2,
            tier: 'every_other_day',
            lastEvaluatedAt: '2026-03-23T00:00:00Z',
            lastFetchStatus: 'covered',
            highValueHitCount: 1,
            lowValueChatCount: 0,
            evaluationCount: 3,
            selectionCount: 3,
            reasoning: 'Useful updates.',
            unseen: false,
          },
          {
            sourceTweetId: '1439790545048457225',
            handle: 'bob',
            displayName: 'Bob Chen',
            userPageUrl: 'https://x.com/bob',
            postCount: 7,
            score: 4,
            tier: 'daily',
            lastEvaluatedAt: '2026-03-23T00:00:00Z',
            lastFetchStatus: 'covered',
            highValueHitCount: 2,
            lowValueChatCount: 0,
            evaluationCount: 3,
            selectionCount: 3,
            reasoning: 'Daily-worthy updates.',
            unseen: false,
          },
        ],
      }, null, 2),
    );

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-24',
    });

    assert.equal(summary.dailyCount, 2);

    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.match(dailyCsv, /alice/);
    assert.match(dailyCsv, /bob/);

    const scoreState = await readJson(summary.scoreFilePath);
    const alice = scoreState.accounts.find((entry) => entry.handle === 'alice');
    const bob = scoreState.accounts.find((entry) => entry.handle === 'bob');
    assert.equal(alice.lastSelectedAt, '2026-03-24');
    assert.equal(bob.lastSelectedAt, '2026-03-24');
  } finally {
    await fixture.cleanup();
  }
});

test('prepareDailyRoster tops up a too-small roster and prefers non-dormant candidates', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    config.roster.minDailyRosterSize = 2;
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const seedCsv = [
      '\uFEFFTweetID,Handle,Name,Bio,CanDM,AccountCreateDate,Location,FollowersCount,FollowingCount,TotalFavouritesByUser,MediaCount,UserPageURL,ProfileBannerURL,ProfileURL,AvatarURL,PostCount,Verified,IsBlueVerified',
      '"1599634054919245824","alice","Alice Maker","Builds tools","false","2022/12/5 13:17:41","Shanghai","3","156","106","0","https://x.com/alice","","https://example.com/alice","https://cdn.example/alice.png","12","false","false"',
      '"1439790545048457225","bob","Bob Chen","Just fun","false","2021/9/20 11:16:41","","0","38","5","0","https://x.com/bob","","","https://cdn.example/bob.png","0","false","false"',
      '"1555555555555555555","charlie","Charlie Ops","Ships infra","false","2020/5/20 11:16:41","","10","12","9","0","https://x.com/charlie","","","https://cdn.example/charlie.png","4","false","false"',
    ].join('\n');
    await writeFile(`${fixture.skillRoot}\\seed.csv`, seedCsv, 'utf8');

    await writeFile(
      `${fixture.skillRoot}\\account-score.json`,
      JSON.stringify({
        meta: {
          stateVersion: 2,
          lastPreparedRunDate: '2026-04-09',
          selectionStrategy: 'cadence_hash_v1',
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
            lastEvaluatedAt: '2026-04-09T00:00:00Z',
            lastSelectedAt: '2026-04-09',
            lastFetchStatus: 'covered',
            highValueHitCount: 2,
            lowValueChatCount: 0,
            evaluationCount: 3,
            selectionCount: 3,
            reasoning: 'Daily-worthy updates.',
            unseen: false,
          },
          {
            sourceTweetId: '1439790545048457225',
            handle: 'bob',
            displayName: 'Bob Chen',
            userPageUrl: 'https://x.com/bob',
            postCount: 0,
            score: 2,
            tier: 'every_other_day',
            lastEvaluatedAt: '2026-04-09T00:00:00Z',
            lastSelectedAt: '2026-04-09',
            lastFetchStatus: 'dormant_skipped',
            nextEligibleAt: '2026-04-10',
            highValueHitCount: 0,
            lowValueChatCount: 0,
            evaluationCount: 3,
            selectionCount: 3,
            reasoning: 'Dormant recently.',
            unseen: false,
          },
          {
            sourceTweetId: '1555555555555555555',
            handle: 'charlie',
            displayName: 'Charlie Ops',
            userPageUrl: 'https://x.com/charlie',
            postCount: 4,
            score: 2,
            tier: 'every_other_day',
            lastEvaluatedAt: '2026-04-09T00:00:00Z',
            lastSelectedAt: '2026-04-09',
            lastFetchStatus: 'covered',
            highValueHitCount: 1,
            lowValueChatCount: 0,
            evaluationCount: 3,
            selectionCount: 3,
            reasoning: 'Stable updates.',
            unseen: false,
          },
        ],
      }, null, 2),
    );

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-04-10',
    });

    assert.equal(summary.dailyCount, 2);

    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.match(dailyCsv, /alice/);
    assert.match(dailyCsv, /charlie/);
    assert.doesNotMatch(dailyCsv, /bob/);

    const scoreState = await readJson(summary.scoreFilePath);
    assert.equal(scoreState.meta.dailyCount, 2);
  } finally {
    await fixture.cleanup();
  }
});

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
            postCount: 12,
            score: 4,
            tier: 'daily',
            lastEvaluatedAt: '2026-03-23T00:00:00Z',
            lastSelectedAt: '2026-03-23',
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
            score: 2,
            tier: 'every_other_day',
            lastEvaluatedAt: '2026-03-23T00:00:00Z',
            lastSelectedAt: '2026-03-22',
            lastFetchStatus: 'dormant_skipped',
            nextEligibleAt: '2026-03-30',
            highValueHitCount: 0,
            lowValueChatCount: 0,
            evaluationCount: 2,
            selectionCount: 2,
            reasoning: 'Dormant recently.',
            unseen: false,
          },
        ],
      }, null, 2),
    );

    const summary = await prepareDailyRoster({
      configPath: fixture.configPath,
      date: '2026-03-24',
    });

    assert.equal(summary.dailyCount, 1);

    const dailyCsv = await readText(summary.dailyCsvPath);
    assert.match(dailyCsv, /alice/);
    assert.doesNotMatch(dailyCsv, /bob/);

    const scoreState = await readJson(summary.scoreFilePath);
    const bob = scoreState.accounts.find((entry) => entry.handle === 'bob');
    assert.equal(bob.lastSelectedAt, '2026-03-22');
    assert.equal(scoreState.meta.cooldownSkippedCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('runRosterScoring updates account scores from GPT decisions without changing Grok fetch behavior', async () => {
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
            postCount: 12,
            score: 2,
            tier: 'every_other_day',
            lastEvaluatedAt: '2026-03-22T00:00:00Z',
            lastSelectedAt: '2026-03-21',
            lastFetchStatus: 'covered',
            highValueHitCount: 0,
            lowValueChatCount: 0,
            evaluationCount: 1,
            selectionCount: 1,
            reasoning: 'Previously useful updates.',
            unseen: false,
          },
          {
            sourceTweetId: '1439790545048457225',
            handle: 'bob',
            displayName: 'Bob Chen',
            userPageUrl: 'https://x.com/bob',
            postCount: 0,
            score: 2,
            tier: 'every_other_day',
            lastEvaluatedAt: '2026-03-22T00:00:00Z',
            lastSelectedAt: '2026-03-22',
            lastFetchStatus: 'no_tweets_found',
            highValueHitCount: 0,
            lowValueChatCount: 0,
            evaluationCount: 1,
            selectionCount: 1,
            reasoning: 'No useful updates yet.',
            unseen: false,
          },
        ],
      }, null, 2),
    );

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

test('runRosterScoring lowers account frequency when GPT flags repeated low-value chatter', async () => {
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
            postCount: 12,
            score: 2,
            tier: 'every_other_day',
            lastEvaluatedAt: '2026-03-22T00:00:00Z',
            lastSelectedAt: '2026-03-21',
            lastFetchStatus: 'covered',
            highValueHitCount: 0,
            lowValueChatCount: 0,
            evaluationCount: 1,
            selectionCount: 1,
            reasoning: 'Previously useful updates.',
            unseen: false,
          },
          {
            sourceTweetId: '1439790545048457225',
            handle: 'bob',
            displayName: 'Bob Chen',
            userPageUrl: 'https://x.com/bob',
            postCount: 0,
            score: 2,
            tier: 'every_other_day',
            lastEvaluatedAt: '2026-03-22T00:00:00Z',
            lastSelectedAt: '2026-03-22',
            lastFetchStatus: 'no_tweets_found',
            highValueHitCount: 0,
            lowValueChatCount: 0,
            evaluationCount: 1,
            selectionCount: 1,
            reasoning: 'No useful updates yet.',
            unseen: false,
          },
        ],
      }, null, 2),
    );

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
        high_value_tweet_count: 0,
        low_value_chat_count: 3,
        reason: 'Mostly short chatter without clear information gain.',
      },
    ], null, 2);

    await runRosterScoring({
      config: loadedConfig,
      skillRoot,
      runDate: '2026-03-23',
      fetchResult,
      profile,
      fetchImpl: createCompletionFetch(scoringResponse),
      runDir: fetchSummary.runDir,
    });

    const scoreState = await readJson(join(fixture.skillRoot, 'account-score.json'));
    const alice = scoreState.accounts.find((entry) => entry.handle === 'alice');
    assert.equal(alice.score, 0);
    assert.equal(alice.tier, 'cold');
    assert.equal(alice.lowValueChatCount, 3);
  } finally {
    await fixture.cleanup();
  }
});

test('runRosterScoring stores dormant cooldown metadata for dormant accounts', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = withRosterConfig(JSON.parse(await readFile(fixture.configPath, 'utf8')));
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const { config: loadedConfig, skillRoot } = await loadConfig(fixture.configPath);
    const sourceDocs = await loadSourceDocuments(loadedConfig, skillRoot);
    const profile = resolveAnalysisProfile(loadedConfig, sourceDocs, 'gpt-default');
    const fetchResult = {
      items: [
        {
          tweetId: '190001',
          username: 'alice',
          displayName: 'Alice Maker',
          createdAt: '2026-03-23T01:02:03Z',
          text: 'Shipped a new CLI for tracing agent runs.',
          originalUrl: 'https://x.com/alice/status/190001',
          source: {
            seedId: 'seed-1',
            sourceTweetId: '1599634054919245824',
            csvRowNumber: 2,
            seedHandle: 'alice',
            displayName: 'Alice Maker',
            userPageUrl: 'https://x.com/alice',
          },
        },
      ],
      accounts: [
        {
          seedId: 'seed-1',
          sourceTweetId: '1599634054919245824',
          handle: 'alice',
          displayName: 'Alice Maker',
          userPageUrl: 'https://x.com/alice',
          status: 'covered',
          tweetCount: 1,
          notes: [],
        },
        {
          seedId: 'seed-2',
          sourceTweetId: '1439790545048457225',
          handle: 'bob',
          displayName: 'Bob Chen',
          userPageUrl: 'https://x.com/bob',
          status: 'dormant_skipped',
          tweetCount: 0,
          notes: ['Dormant because no recent tweets were found.'],
          dormantReason: 'inactive',
          lastTweetDate: '2026-02-01T12:00:00Z',
          daysSinceLastTweet: 50.1,
        },
      ],
    };

    await runRosterScoring({
      config: loadedConfig,
      skillRoot,
      runDate: '2026-03-23',
      fetchResult,
      profile,
      fetchImpl: createCompletionFetch('[]'),
      runDir: join(fixture.skillRoot, 'data'),
    });

    const scoreState = await readJson(join(fixture.skillRoot, 'account-score.json'));
    const bob = scoreState.accounts.find((entry) => entry.handle === 'bob');
    assert.equal(bob.lastFetchStatus, 'dormant_skipped');
    assert.equal(bob.nextEligibleAt, '2026-03-30');
  } finally {
    await fixture.cleanup();
  }
});
