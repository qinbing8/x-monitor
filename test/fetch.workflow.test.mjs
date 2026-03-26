import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { runFetch } from '../scripts/fetch.mjs';
import {
  FIXTURE_INVALID_FETCH_RESPONSE,
  FIXTURE_PRECHECK_RESPONSE_DORMANT,
  FIXTURE_REFERENCE_TIME,
  FIXTURE_TWEET_FETCH_RESPONSE,
  createCompletionFetch,
  createCompletionFetchSequence,
  createMockSkillFixture,
  readJson,
} from '../support/fixtures.mjs';

test('runFetch refetches no_tweets_found accounts in a second pass and keeps improved coverage', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    Object.assign(config.fetch.profiles['grok-default'], {
      refetchOnStatuses: ['no_tweets_found', 'incomplete'],
      refetchMaxRounds: 1,
      refetchBatchSize: 1,
      refetchConcurrency: 1,
    });
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const emptyCsv = 'username,tweet_id,created_at,text,original_url\n';
    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetchSequence([emptyCsv, FIXTURE_TWEET_FETCH_RESPONSE, emptyCsv]),
    });

    assert.equal(result.tweetCount, 2);
    const fetchRaw = await readJson(result.fetchRawPath);
    assert.equal(fetchRaw.meta.initialBatchCount, 1);
    assert.equal(fetchRaw.meta.refetchRoundCount, 1);
    assert.equal(fetchRaw.meta.refetchedAccountCount, 2);
    assert.equal(fetchRaw.batches[1].attemptKind, 'refetch');

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.recoveredByRefetchCount, 1);
    assert.equal(fetchResult.accounts[0].status, 'covered');
    assert.equal(fetchResult.accounts[0].initialStatus, 'no_tweets_found');
    assert.equal(fetchResult.accounts[0].recoveredByRefetch, true);
    assert.equal(fetchResult.refetch.recoveredAccounts[0].handle, 'alice');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch records unresolved incomplete and failed accounts after refetch', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    Object.assign(config.fetch.profiles['grok-default'], {
      refetchOnStatuses: ['no_tweets_found', 'incomplete', 'fetch_failed'],
      refetchMaxRounds: 1,
      refetchBatchSize: 1,
      refetchConcurrency: 1,
    });
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const aliceOutsideWindowCsv = [
      'username,tweet_id,created_at,text,original_url',
      '"alice","190021","2026-03-22T10:15:00.000Z","Outside the 24h window and must be dropped.","https://x.com/alice/status/190021"',
    ].join('\n');

    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetchSequence([
        FIXTURE_INVALID_FETCH_RESPONSE,
        aliceOutsideWindowCsv,
        FIXTURE_INVALID_FETCH_RESPONSE,
      ]),
    });

    assert.equal(result.tweetCount, 0);
    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.recoveredByRefetchCount, 0);
    assert.equal(fetchResult.meta.stayedIncompleteAccountCount, 1);
    assert.equal(fetchResult.meta.stayedSoftFailedAccountCount, 1);
    assert.equal(fetchResult.accounts[0].status, 'incomplete');
    assert.equal(fetchResult.accounts[1].status, 'soft_failed');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch with precheck enabled skips dormant accounts and records them in result', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.fetch.profiles['grok-default'].precheck = {
      enabled: true,
      dormantThresholdDays: 7,
      batchSize: 10,
      timeoutMs: 5000,
      maxOutputTokens: 500,
      promptFile: './assets/prompts/grok-precheck.txt',
    };
    config.fetch.profiles['grok-default'].refetchMaxRounds = 0;
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    let callIndex = 0;
    const mockFetch = async () => {
      callIndex += 1;
      const content = callIndex === 1 ? FIXTURE_PRECHECK_RESPONSE_DORMANT : FIXTURE_TWEET_FETCH_RESPONSE;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    };

    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: mockFetch,
    });

    assert.equal(result.activeSeedCount, 1);
    assert.equal(result.dormantSeedCount, 1);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.precheckEnabled, true);
    const dormantAccount = fetchResult.accounts.find((account) => account.status === 'dormant_skipped');
    assert.equal(dormantAccount.handle, 'bob');
    assert.ok(dormantAccount.daysSinceLastTweet > 7);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch staticFilterZeroPosts skips zero-post accounts without undefined dormant metadata', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.fetch.profiles['grok-default'].precheck = {
      enabled: true,
      staticFilterZeroPosts: true,
      dormantThresholdDays: 7,
      batchSize: 10,
      timeoutMs: 5000,
      maxOutputTokens: 500,
      promptFile: './assets/prompts/grok-precheck.txt',
    };
    config.fetch.profiles['grok-default'].refetchMaxRounds = 0;
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    let callIndex = 0;
    const mockFetch = async () => {
      callIndex += 1;
      const content = callIndex === 1
        ? 'username,last_tweet_date\n"alice","2026-03-23T01:00:00Z"'
        : FIXTURE_TWEET_FETCH_RESPONSE;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    };

    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: mockFetch,
    });

    assert.equal(result.activeSeedCount, 1);
    assert.equal(result.dormantSeedCount, 1);

    const fetchResult = await readJson(result.fetchResultPath);
    const dormantAccount = fetchResult.accounts.find((account) => account.status === 'dormant_skipped');
    assert.equal(dormantAccount.dormantReason, 'zero_posts');
    assert.equal(dormantAccount.lastTweetDate, null);
    assert.equal(dormantAccount.daysSinceLastTweet, null);
    assert.deepEqual(dormantAccount.notes, ['Dormant: skipped because seed CSV reports postCount=0.']);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch with skip-precheck bypasses precheck and fetches all accounts', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.fetch.profiles['grok-default'].precheck = {
      enabled: true,
      staticFilterZeroPosts: true,
      dormantThresholdDays: 7,
      batchSize: 10,
      timeoutMs: 5000,
      maxOutputTokens: 500,
      promptFile: './assets/prompts/grok-precheck.txt',
    };
    config.fetch.profiles['grok-default'].refetchMaxRounds = 0;
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
      skipPrecheck: true,
    });

    assert.equal(result.seedCount, 2);
    assert.equal(result.activeSeedCount, 2);
    assert.equal(result.dormantSeedCount, 0);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.precheckEnabled, false);
    assert.equal(fetchResult.accounts.filter((account) => account.status === 'dormant_skipped').length, 0);
  } finally {
    await fixture.cleanup();
  }
});
