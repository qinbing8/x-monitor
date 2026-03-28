import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFetch } from '../scripts/fetch.mjs';
import {
  FIXTURE_HEADERLESS_FETCH_RESPONSE,
  FIXTURE_INVALID_FETCH_RESPONSE,
  FIXTURE_MALFORMED_MULTILINE_FETCH_RESPONSE,
  FIXTURE_OUT_OF_WINDOW_FETCH_RESPONSE,
  FIXTURE_PROSE_MIXED_FETCH_RESPONSE,
  FIXTURE_REFERENCE_TIME,
  FIXTURE_TWEET_FETCH_RESPONSE,
  createCompletionFetch,
  createMockSkillFixture,
  readJson,
  readText,
} from '../support/fixtures.mjs';

async function withMockedNow(nowIso, task) {
  const fixedMs = Date.parse(nowIso);
  const RealDate = globalThis.Date;
  class MockDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedMs] : args));
    }
    static now() {
      return fixedMs;
    }
  }

  globalThis.Date = MockDate;
  try {
    return await task();
  } finally {
    globalThis.Date = RealDate;
  }
}

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

test('repo fetch profiles keep baseline recovery defaults for live runs', async () => {
  const repoConfig = await readJson(fileURLToPath(new URL('../config.json', import.meta.url)));
  const exampleConfig = await readJson(fileURLToPath(new URL('../config.example.json', import.meta.url)));

  for (const [label, config] of [['config.json', repoConfig], ['config.example.json', exampleConfig]]) {
    const profile = config.fetch.profiles['grok-default'];
    assert.equal(profile.batchSize, 3, `${label} grok-default batchSize must stay at 3`);
    assert.ok(profile.refetchOnStatuses.includes('fetch_failed'));
    assert.ok(profile.refetchOnStatuses.includes('soft_failed'));
  }
});

test('runFetch smoke writes fetch artifacts from a controlled completion', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    assert.equal(result.seedCount, 2);
    assert.equal(result.accountCount, 2);
    assert.equal(result.tweetCount, 2);
    assert.equal(result.windowStartUtc, '2026-03-22T14:21:05.770Z');
    assert.equal(result.windowEndUtc, FIXTURE_REFERENCE_TIME);
    assert.ok(result.durationMs >= 0);
    assert.equal(join(result.runDir, 'fetch.input.json'), result.fetchInputPath);
    assert.equal(join(result.runDir, 'fetch.raw.json'), result.fetchRawPath);
    assert.equal(join(result.runDir, 'fetch.raw.csv'), result.fetchRawCsvPath);
    assert.equal(join(result.runDir, 'fetch.tweet-index.csv'), result.fetchTweetIndexCsvPath);
    assert.equal(join(result.runDir, 'fetch.result.json'), result.fetchResultPath);

    const fetchInput = await readJson(result.fetchInputPath);
    assert.equal(fetchInput.task.sourceCsvPath, join(fixture.skillRoot, 'seed.csv'));
    assert.equal(fetchInput.task.seedCount, 2);
    assert.equal(fetchInput.task.windowStartUtc, '2026-03-22T14:21:05.770Z');
    assert.equal(fetchInput.task.windowEndUtc, FIXTURE_REFERENCE_TIME);
    assert.equal(fetchInput.seeds[0].handle, 'alice');
    assert.equal(fetchInput.seeds[0].sourceTweetId, '1599634054919245824');

    const fetchRaw = await readJson(result.fetchRawPath);
    assert.equal(fetchRaw.batches.length, 1);
    assert.equal(fetchRaw.batches[0].seedIds[0], 'seed-1');
    assert.equal(fetchRaw.batches[0].parseError, null);

    const fetchRawCsv = await readText(result.fetchRawCsvPath);
    assert.match(fetchRawCsv, /^username,tweet_id,created_at,text,original_url/m);
    assert.match(fetchRawCsv, /190001/);
    const fetchTweetIndexCsv = await readText(result.fetchTweetIndexCsvPath);
    assert.match(fetchTweetIndexCsv, /^TweetID,UserPageURL,Handle,Name/m);
    assert.match(fetchTweetIndexCsv, /190001/);
    assert.match(fetchTweetIndexCsv, /https:\/\/x\.com\/alice/);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.sourceProvider, 'grok');
    assert.equal(fetchResult.meta.seedCount, 2);
    assert.equal(fetchResult.meta.tweetCount, 2);
    assert.equal(fetchResult.meta.windowStartUtc, '2026-03-22T14:21:05.770Z');
    assert.equal(fetchResult.meta.windowEndUtc, FIXTURE_REFERENCE_TIME);
    assert.equal(fetchResult.meta.fetchTweetIndexCsvPath, result.fetchTweetIndexCsvPath);
    assert.ok(fetchResult.meta.durationMs >= 0);
    assert.equal(fetchResult.items[0].source.sourceTweetId, '1599634054919245824');
    assert.equal(fetchResult.accounts[0].status, 'covered');
    assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch uses the current execution time as the default window anchor when only date is provided', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const result = await withMockedNow(FIXTURE_REFERENCE_TIME, () => runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    }));

    assert.equal(result.windowStartUtc, '2026-03-22T14:21:05.770Z');
    assert.equal(result.windowEndUtc, FIXTURE_REFERENCE_TIME);

    const fetchInput = await readJson(result.fetchInputPath);
    assert.equal(fetchInput.task.windowEndUtc, FIXTURE_REFERENCE_TIME);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.fetchedAt, FIXTURE_REFERENCE_TIME);
    assert.equal(fetchResult.meta.windowEndUtc, FIXTURE_REFERENCE_TIME);
    assert.equal(fetchResult.items.length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch ignores prose no-data rows mixed into CSV output without unmatched warnings', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_PROSE_MIXED_FETCH_RESPONSE),
    });

    assert.equal(result.tweetCount, 1);
    const fetchRawCsv = await readText(result.fetchRawCsvPath);
    assert.equal(fetchRawCsv.includes('没有符合条件的推文'), false);
    assert.equal(fetchRawCsv.includes('由于这些账号在过去24小时内没有符合条件的帖子'), false);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.items.length, 1);
    assert.equal(fetchResult.items[0].tweetId, '190010');
    assert.equal(fetchResult.warnings.length, 0);
    assert.equal(fetchResult.accounts[0].status, 'covered');
    assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch excludes tweets outside the deterministic 24h window from result and raw CSV', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_OUT_OF_WINDOW_FETCH_RESPONSE),
    });

    assert.equal(result.tweetCount, 1);
    const fetchRawCsv = await readText(result.fetchRawCsvPath);
    assert.match(fetchRawCsv, /190011/);
    assert.doesNotMatch(fetchRawCsv, /190012/);

    const fetchRaw = await readJson(result.fetchRawPath);
    assert.equal(fetchRaw.batches[0].droppedOutsideWindowCount, 1);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.fetchedAt, FIXTURE_REFERENCE_TIME);
    assert.equal(fetchResult.items[0].tweetId, '190011');
    assert.equal(fetchResult.warnings.some((warning) => warning.type === 'tweet_outside_time_window'), true);
    assert.equal(fetchResult.accounts[0].status, 'covered');
    assert.equal(fetchResult.accounts[0].notes.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch records timeout diagnostics in artifacts and emits batch timeout logs', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.defaults.logLevel = 'info';
    Object.assign(config.fetch.profiles['grok-default'], {
      batchSize: 2,
      refetchMaxRounds: 0,
      retry: { maxAttempts: 2, backoffMs: 0 },
    });
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    let attempts = 0;
    let result;
    const output = await captureStderr(async (chunks) => {
      result = await runFetch({
        configPath: fixture.configPath,
        date: '2026-03-23',
        referenceTime: FIXTURE_REFERENCE_TIME,
        fetchImpl: async () => {
          attempts += 1;
          throw new Error('Request timed out after 5000ms');
        },
      });
      return chunks.join('');
    });

    assert.equal(attempts, 2);
    assert.equal(result.parseErrorCount, 1);
    assert.equal(result.softFailedAccountCount, 2);
    assert.match(output, /"event":"fetch_batch_start"/);
    assert.match(output, /"event":"llm_request_failed"/);
    assert.match(output, /"event":"fetch_batch_failed"/);
    assert.match(output, /"errorClassification":"timeout"/);
    assert.match(output, /"retryExhausted":true/);

    const fetchRaw = await readJson(result.fetchRawPath);
    assert.equal(fetchRaw.batches[0].parseError, 'Request timed out after 5000ms');
    assert.equal(fetchRaw.batches[0].diagnostics.classification, 'timeout');
    assert.equal(fetchRaw.batches[0].diagnostics.timeoutMs, 5000);
    assert.equal(fetchRaw.batches[0].retryDiagnostics.maxAttempts, 2);
    assert.equal(fetchRaw.batches[0].retryDiagnostics.exhausted, true);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.accounts[0].status, 'soft_failed');
    assert.equal(fetchResult.accounts[1].status, 'soft_failed');
    assert.equal(fetchResult.meta.parseErrorCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch recovers malformed multiline tweet rows into valid tweet evidence', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    Object.assign(config.fetch.profiles['grok-default'], {
      batchSize: 1,
      refetchMaxRounds: 0,
    });
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_MALFORMED_MULTILINE_FETCH_RESPONSE),
    });

    assert.equal(result.tweetCount, 2);
    assert.equal(result.incompleteAccountCount, 0);

    const fetchRaw = await readJson(result.fetchRawPath);
    assert.equal(fetchRaw.batches[0].parserDiagnostics.strategy, 'recovered_rows');

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.accounts[0].status, 'covered');
    assert.equal(fetchResult.accounts[0].tweetCount, 2);
    assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');
    assert.match(fetchResult.items[0].text, /multiline notes and commas/);
    assert.equal(fetchResult.items[1].originalUrl, 'https://x.com/alice/status/190014');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch recovers headerless tweet CSV rows into valid tweet evidence', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    Object.assign(config.fetch.profiles['grok-default'], {
      batchSize: 1,
      refetchMaxRounds: 0,
    });
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_HEADERLESS_FETCH_RESPONSE),
    });

    assert.equal(result.tweetCount, 2);
    assert.equal(result.failedAccountCount, 0);

    const fetchRaw = await readJson(result.fetchRawPath);
    assert.equal(fetchRaw.batches[0].parserDiagnostics.strategy, 'headerless_rows');
    assert.equal(fetchRaw.batches[0].responseClassification, 'headerless_csv');

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.accounts[0].status, 'covered');
    assert.equal(fetchResult.accounts[0].tweetCount, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch preserves malformed mapped rows as incomplete evidence', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    Object.assign(config.fetch.profiles['grok-default'], {
      batchSize: 1,
      refetchMaxRounds: 0,
    });
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const malformedCsv = [
      'username,tweet_id,created_at,text,original_url',
      '"alice","","2026-03-23T03:00:00Z","","https://x.com/alice/status/"',
    ].join('\n');

    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(malformedCsv),
    });

    assert.equal(result.tweetCount, 0);
    assert.equal(result.incompleteAccountCount, 1);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.accounts[0].status, 'incomplete');
    assert.match(fetchResult.accounts[0].notes[0], /Missing or invalid required fields:/);
    assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch keeps batch failures in artifacts so downstream analysis can still continue', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const result = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_INVALID_FETCH_RESPONSE),
    });

    assert.equal(result.tweetCount, 0);
    assert.equal(result.parseErrorCount, 1);
    assert.equal(result.softFailedAccountCount, 2);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.accounts[0].status, 'soft_failed');
    assert.equal(fetchResult.accounts[1].status, 'soft_failed');
    assert.equal(fetchResult.warnings[0].type, 'batch_parse_error');
  } finally {
    await fixture.cleanup();
  }
});
