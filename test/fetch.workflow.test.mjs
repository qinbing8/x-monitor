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

async function captureStderr(fn) {
  const chunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, encoding, callback) => {
    chunks.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  });
  try {
    return await fn(chunks);
  } finally {
    process.stderr.write = originalWrite;
  }
}

function extractPromptHandles(prompt) {
  return [...String(prompt ?? '').matchAll(/"handle"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
}

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

test('runFetch keeps fetch prompts focused on handle and profile url only', async () => {
  const fixture = await createMockSkillFixture();
  try {
    let capturedPrompt = '';
    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options?.body ?? '{}');
        capturedPrompt = String(body.messages?.[0]?.content ?? body.input?.[0]?.content ?? '');
        return createCompletionFetch('username,tweet_id,created_at,text,original_url\n')(null, { body: JSON.stringify(body) });
      },
    });

    assert.match(capturedPrompt, /"handle"\s*:\s*"alice"/);
    assert.match(capturedPrompt, /"user_page_url"\s*:\s*"https:\/\/x\.com\/alice"/);
    assert.doesNotMatch(capturedPrompt, /"bio"\s*:/);
    assert.doesNotMatch(capturedPrompt, /"seed_id"\s*:/);
    assert.doesNotMatch(capturedPrompt, /"source_tweet_id"\s*:/);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch smoke shows how refetchBatchSize=2 and =3 split the same three-account retry set', async () => {
  async function runScenario(refetchBatchSize) {
    const fixture = await createMockSkillFixture();
    try {
      const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
      Object.assign(config.fetch.profiles['grok-default'], {
        batchSize: 3,
        refetchOnStatuses: ['no_tweets_found'],
        refetchMaxRounds: 1,
        refetchBatchSize,
        refetchConcurrency: 1,
      });
      await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

      const seedCsv = [
        '\uFEFFTweetID,Handle,Name,Bio,CanDM,AccountCreateDate,Location,FollowersCount,FollowingCount,TotalFavouritesByUser,MediaCount,UserPageURL,ProfileBannerURL,ProfileURL,AvatarURL,PostCount,Verified,IsBlueVerified',
        '"1599634054919245824","alice","Alice Maker","Builds tools","false","2022/12/5 13:17:41","Shanghai","3","156","106","0","https://x.com/alice","","https://example.com/alice","https://cdn.example/alice.png","12","false","false"',
        '"1439790545048457225","bob","Bob Chen","Just fun","false","2021/9/20 11:16:41","","0","38","5","0","https://x.com/bob","","","https://cdn.example/bob.png","1","false","false"',
        '"1555555555555555555","charlie","Charlie Ops","Ships infra","false","2020/5/20 11:16:41","","10","12","9","0","https://x.com/charlie","","","https://cdn.example/charlie.png","4","false","false"',
      ].join('\n');
      await writeFile(`${fixture.skillRoot}\\seed.csv`, seedCsv, 'utf8');

      let callIndex = 0;
      const requestBatches = [];
      const result = await runFetch({
        configPath: fixture.configPath,
        date: '2026-03-23',
        referenceTime: FIXTURE_REFERENCE_TIME,
        fetchImpl: async (_url, options) => {
          callIndex += 1;
          const body = JSON.parse(options?.body ?? '{}');
          const prompt = String(body.messages?.[0]?.content ?? body.input?.[0]?.content ?? '');
          const handles = extractPromptHandles(prompt);
          requestBatches.push(handles);

          if (callIndex === 1) {
            return createCompletionFetchSequence(['username,tweet_id,created_at,text,original_url\n'])(null, { body: JSON.stringify(body) });
          }

          const recoveredCsv = [
            'username,tweet_id,created_at,text,original_url',
            ...handles.map((handle, index) => {
              const tweetId = handle === 'alice'
                ? '190101'
                : handle === 'bob'
                  ? '190102'
                  : `19010${index + 3}`;
              return `"${handle}","${tweetId}","2026-03-23T03:00:00Z","${handle} recovered during refetch.","https://x.com/${handle}/status/${tweetId}"`;
            }),
          ].join('\n');
          return createCompletionFetchSequence([recoveredCsv])(null, { body: JSON.stringify(body) });
        },
      });

      const fetchRaw = await readJson(result.fetchRawPath);
      const fetchResult = await readJson(result.fetchResultPath);
      return {
        requestBatches,
        executedBatchCount: fetchResult.meta.executedBatchCount,
        refetchBatchCount: fetchRaw.batches.filter((batch) => batch.attemptKind === 'refetch').length,
        recoveredByRefetchCount: fetchResult.meta.recoveredByRefetchCount,
        accountStatuses: fetchResult.accounts.map((account) => account.status),
        cleanup: fixture.cleanup,
      };
    } catch (error) {
      await fixture.cleanup();
      throw error;
    }
  }

  const batchSize2 = await runScenario(2);
  const batchSize3 = await runScenario(3);
  try {
    assert.equal(batchSize2.recoveredByRefetchCount, 3);
    assert.equal(batchSize3.recoveredByRefetchCount, 3);
    assert.deepEqual(batchSize2.accountStatuses, ['covered', 'covered', 'covered']);
    assert.deepEqual(batchSize3.accountStatuses, ['covered', 'covered', 'covered']);

    assert.equal(batchSize2.refetchBatchCount, 2);
    assert.equal(batchSize3.refetchBatchCount, 1);
    assert.equal(batchSize2.executedBatchCount, 3);
    assert.equal(batchSize3.executedBatchCount, 2);

    assert.deepEqual(batchSize2.requestBatches[0], ['alice', 'bob', 'charlie']);
    assert.equal(batchSize2.requestBatches[1].length, 2);
    assert.equal(batchSize2.requestBatches[2].length, 1);
    assert.deepEqual(
      [...batchSize2.requestBatches[1], ...batchSize2.requestBatches[2]].sort(),
      ['alice', 'bob', 'charlie'],
    );
    assert.deepEqual(batchSize3.requestBatches[0], ['alice', 'bob', 'charlie']);
    assert.equal(batchSize3.requestBatches[1].length, 3);
    assert.deepEqual(batchSize3.requestBatches[1].slice().sort(), ['alice', 'bob', 'charlie']);
  } finally {
    await batchSize2.cleanup();
    await batchSize3.cleanup();
  }
});

test('runFetch preserves refetch timeout diagnostics even when accounts remain no_tweets_found', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.defaults.logLevel = 'info';
    Object.assign(config.fetch.profiles['grok-default'], {
      batchSize: 2,
      refetchOnStatuses: ['no_tweets_found'],
      refetchMaxRounds: 1,
      refetchBatchSize: 1,
      refetchConcurrency: 1,
      retry: { maxAttempts: 2, backoffMs: 0 },
    });
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const emptyCsv = 'username,tweet_id,created_at,text,original_url\n';
    let callIndex = 0;
    let result;
    const output = await captureStderr(async (chunks) => {
      result = await runFetch({
        configPath: fixture.configPath,
        date: '2026-03-23',
        referenceTime: FIXTURE_REFERENCE_TIME,
        fetchImpl: async (_url, options) => {
          callIndex += 1;
          if (callIndex === 1) {
            const body = JSON.parse(options?.body ?? '{}');
            return createCompletionFetchSequence([emptyCsv])(null, { body: JSON.stringify(body) });
          }
          if (callIndex === 2 || callIndex === 3) {
            throw new Error('Request timed out after 5000ms');
          }
          return createCompletionFetchSequence([emptyCsv])(null, options);
        },
      });
      return chunks.join('');
    });

    assert.equal(result.parseErrorCount, 1);
    assert.match(output, /"event":"fetch_batch_start"/);
    assert.match(output, /"attemptKind":"refetch"/);
    assert.match(output, /"event":"fetch_batch_failed"/);
    assert.match(output, /"errorClassification":"timeout"/);

    const fetchRaw = await readJson(result.fetchRawPath);
    const timeoutBatch = fetchRaw.batches.find((batch) => batch.attemptKind === 'refetch' && batch.diagnostics?.classification === 'timeout');
    assert.ok(timeoutBatch);
    assert.equal(timeoutBatch.round, 1);
    assert.equal(timeoutBatch.retryDiagnostics.maxAttempts, 2);
    assert.equal(timeoutBatch.retryDiagnostics.exhausted, true);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.stayedSoftFailedAccountCount, 0);
    assert.equal(fetchResult.meta.stayedNoTweetAccountCount, 2);
    assert.equal(fetchResult.accounts.filter((account) => account.wasRefetched).length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch splits timeout-soft-failed batches into single-seed refetches', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    Object.assign(config.fetch.profiles['grok-default'], {
      batchSize: 3,
      refetchOnStatuses: ['soft_failed', 'fetch_failed'],
      refetchMaxRounds: 1,
      refetchBatchSize: 3,
      refetchConcurrency: 1,
      retry: { maxAttempts: 1, backoffMs: 0 },
    });
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const seedCsv = [
      '\uFEFFTweetID,Handle,Name,Bio,CanDM,AccountCreateDate,Location,FollowersCount,FollowingCount,TotalFavouritesByUser,MediaCount,UserPageURL,ProfileBannerURL,ProfileURL,AvatarURL,PostCount,Verified,IsBlueVerified',
      '"1599634054919245824","alice","Alice Maker","Builds tools","false","2022/12/5 13:17:41","Shanghai","3","156","106","0","https://x.com/alice","","https://example.com/alice","https://cdn.example/alice.png","12","false","false"',
      '"1439790545048457225","bob","Bob Chen","Just fun","false","2021/9/20 11:16:41","","0","38","5","0","https://x.com/bob","","","https://cdn.example/bob.png","1","false","false"',
      '"1555555555555555555","charlie","Charlie Ops","Ships infra","false","2020/5/20 11:16:41","","10","12","9","0","https://x.com/charlie","","","https://cdn.example/charlie.png","4","false","false"',
    ].join('\n');
    await writeFile(`${fixture.skillRoot}\\seed.csv`, seedCsv, 'utf8');

    let callIndex = 0;
    const requestBatches = [];
    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options?.body ?? '{}');
        const prompt = String(body.messages?.[0]?.content ?? body.input?.[0]?.content ?? '');
        const handles = extractPromptHandles(prompt);
        requestBatches.push(handles);
        callIndex += 1;

        if (callIndex === 1) {
          throw new Error('Request timed out after 5000ms');
        }

        const recoveredCsv = [
          'username,tweet_id,created_at,text,original_url',
          ...handles.map((handle, index) => {
            const tweetId = handle === 'alice'
              ? '190201'
              : handle === 'bob'
                ? '190202'
                : `19020${index + 3}`;
            return `"${handle}","${tweetId}","2026-03-23T03:00:00Z","${handle} recovered during single-seed refetch.","https://x.com/${handle}/status/${tweetId}"`;
          }),
        ].join('\n');
        return createCompletionFetchSequence([recoveredCsv])(null, { body: JSON.stringify(body) });
      },
    });

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.recoveredByRefetchCount, 3);
    assert.deepEqual(fetchResult.accounts.map((account) => account.status), ['covered', 'covered', 'covered']);
    assert.deepEqual(requestBatches[0], ['alice', 'bob', 'charlie']);
    assert.equal(requestBatches.length, 4);
    assert.ok(requestBatches.slice(1).every((batch) => batch.length === 1));
    assert.deepEqual(requestBatches.slice(1).flat().sort(), ['alice', 'bob', 'charlie']);
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
