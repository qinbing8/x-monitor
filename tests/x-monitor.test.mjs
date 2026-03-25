import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveJsonPath, loadConfig, loadSourceDocuments } from '../scripts/config-loader.mjs';
import { resolveAnalysisProfile, resolveFetchProfile } from '../scripts/provider-resolver.mjs';
import {
  parseCsv,
  normalizeSeedAccounts,
  parseTweetCsvResponse,
  normalizeTweetRecords,
  summarizeBatchCoverage,
  runFetch,
  runActivityPrecheck,
} from '../scripts/fetch.mjs';
import { buildTweetEvidenceBlock, runAnalyze, resolveAnalyzeTimeoutMs } from '../scripts/analyze.mjs';
import { parseArgs } from '../scripts/run.mjs';
import {
  FIXTURE_ANALYZE_MARKDOWN,
  FIXTURE_ANALYZE_MARKDOWN_PART1,
  FIXTURE_ANALYZE_MARKDOWN_PART2,
  FIXTURE_INVALID_FETCH_RESPONSE,
  FIXTURE_OUT_OF_WINDOW_FETCH_RESPONSE,
  FIXTURE_OPENCLAW,
  FIXTURE_PRECHECK_RESPONSE_ALL_ACTIVE,
  FIXTURE_PRECHECK_RESPONSE_DORMANT,
  FIXTURE_PROSE_MIXED_FETCH_RESPONSE,
  FIXTURE_REFERENCE_TIME,
  FIXTURE_SEARCH,
  FIXTURE_SEED_CSV,
  FIXTURE_TWEET_FETCH_RESPONSE,
  createCompletionFetch,
  createCompletionFetchSequence,
  createCompletionFetchSequenceWithFinishReason,
  createMockSkillFixture,
  readJson,
  readText,
} from './test-fixtures.mjs';

test('resolveJsonPath handles simple dollar-dot paths', () => {
  const input = { a: { b: { c: 1 } } };
  assert.equal(resolveJsonPath(input, '$.a.b.c'), 1);
  assert.equal(resolveJsonPath(input, '$.a.x'), undefined);
});

test('provider resolution switches analysis profile between gpt and claude', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const { config } = await loadConfig(fixture.configPath);
    const sourceDocs = await loadSourceDocuments(config, fixture.skillRoot);

    const fetchProfile = resolveFetchProfile(config, sourceDocs, 'grok-default');
    assert.equal(fetchProfile.model, FIXTURE_SEARCH.grok.model);
    assert.equal(fetchProfile.provider.baseUrl, FIXTURE_SEARCH.grok.apiUrl);

    const gptProfile = resolveAnalysisProfile(config, sourceDocs, 'gpt-default');
    assert.equal(gptProfile.modelId, 'gpt-5.4(xhigh)');
    assert.equal(gptProfile.provider.baseUrl, FIXTURE_OPENCLAW.models.providers['router-gpt'].baseUrl);

    const claudeProfile = resolveAnalysisProfile(config, sourceDocs, 'claude-default');
    assert.equal(claudeProfile.modelId, 'claude-sonnet-4-6');
    assert.equal(claudeProfile.provider.baseUrl, FIXTURE_OPENCLAW.models.providers.anyrouter.baseUrl);
  } finally {
    await fixture.cleanup();
  }
});

test('repo analysis profiles keep timeout above the known 90000ms live-run failure threshold', async () => {
  const repoConfig = await readJson(fileURLToPath(new URL('../config.json', import.meta.url)));
  const exampleConfig = await readJson(fileURLToPath(new URL('../config.example.json', import.meta.url)));

  for (const [label, config] of [['config.json', repoConfig], ['config.example.json', exampleConfig]]) {
    assert.ok(
      config.analysis.profiles['gpt-default'].timeoutMs > 90000,
      `${label} gpt-default timeoutMs must stay above 90000ms`,
    );
    assert.ok(
      config.analysis.profiles['claude-default'].timeoutMs > 90000,
      `${label} claude-default timeoutMs must stay above 90000ms`,
    );
  }
});

test('repo fetch profiles keep baseline recovery defaults for live runs', async () => {
  const repoConfig = await readJson(fileURLToPath(new URL('../config.json', import.meta.url)));
  const exampleConfig = await readJson(fileURLToPath(new URL('../config.example.json', import.meta.url)));

  for (const [label, config] of [['config.json', repoConfig], ['config.example.json', exampleConfig]]) {
    const profile = config.fetch.profiles['grok-default'];
    assert.equal(profile.batchSize, 1, `${label} grok-default batchSize must stay at 1`);
    assert.ok(
      profile.refetchOnStatuses.includes('fetch_failed'),
      `${label} grok-default refetchOnStatuses must cover fetch_failed`,
    );
    assert.ok(
      profile.refetchOnStatuses.includes('soft_failed'),
      `${label} grok-default refetchOnStatuses must cover soft_failed`,
    );
  }
});

test('resolveAnalyzeTimeoutMs enforces a live-safe timeout floor', () => {
  assert.equal(resolveAnalyzeTimeoutMs(90000), 300000);
  assert.equal(resolveAnalyzeTimeoutMs(180000), 300000);
  assert.equal(resolveAnalyzeTimeoutMs(240000), 300000);
  assert.equal(resolveAnalyzeTimeoutMs(360000), 360000);
  assert.equal(resolveAnalyzeTimeoutMs(undefined), 300000);
});

test('parseCsv handles BOM headers and normalizes CSV seed rows', () => {
  const parsed = parseCsv(FIXTURE_SEED_CSV);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].Handle, 'alice');
  assert.equal(parsed[0].Bio, 'Builds tools, writes notes');

  const seeds = normalizeSeedAccounts(parsed);
  assert.deepEqual(seeds[0], {
    seedId: 'seed-1',
    csvRowNumber: 2,
    sourceTweetId: '1599634054919245824',
    handle: 'alice',
    displayName: 'Alice Maker',
    bio: 'Builds tools, writes notes',
    canDm: false,
    accountCreatedAt: '2022/12/5 13:17:41',
    location: 'Shanghai',
    followersCount: 3,
    followingCount: 156,
    totalFavouritesByUser: 106,
    mediaCount: 0,
    userPageUrl: 'https://x.com/alice',
    profileBannerUrl: '',
    profileUrl: 'https://example.com/alice',
    avatarUrl: 'https://cdn.example/alice.png',
    postCount: 12,
    verified: false,
    isBlueVerified: false,
    sourceType: 'account_seed',
  });
});

test('parseTweetCsvResponse and normalization tolerate fenced CSV output', () => {
  const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
  const { records } = parseTweetCsvResponse(FIXTURE_TWEET_FETCH_RESPONSE);
  assert.equal(records.length, 2);

  const { items, rowIssues } = normalizeTweetRecords(seeds, records, 'batch-1');
  assert.equal(items.length, 2);
  assert.equal(rowIssues.length, 0);
  assert.equal(items[0].tweetId, '190001');
  assert.equal(items[0].username, 'alice');
  assert.equal(items[1].originalUrl, 'https://x.com/alice/status/190002');

  const coverage = summarizeBatchCoverage(seeds, items, rowIssues, 'batch-1');
  assert.equal(coverage[0].status, 'covered');
  assert.equal(coverage[0].tweetCount, 2);
  assert.equal(coverage[1].status, 'no_tweets_found');
});

test('parseArgs supports mode, analysis-profile, seed-csv, batch-size and skip-precheck overrides', () => {
  const parsed = parseArgs([
    '--mode', 'analyze',
    '--analysis-profile', 'claude-default',
    '--date', '2026-03-23',
    '--seed-csv', '.\\seed.csv',
    '--batch-size', '8',
    '--skip-precheck',
  ]);
  assert.equal(parsed.mode, 'analyze');
  assert.equal(parsed.analysisProfile, 'claude-default');
  assert.equal(parsed.date, '2026-03-23');
  assert.equal(parsed.seedCsvPath, '.\\seed.csv');
  assert.equal(parsed.batchSize, 8);
  assert.equal(parsed.skipPrecheck, true);
});

test('buildTweetEvidenceBlock formats tweet items and coverage into the analysis prompt block', () => {
  const block = buildTweetEvidenceBlock({
    meta: { sourceProvider: 'grok', timeWindowHours: 24 },
    accounts: [
      { seedId: 'seed-1', handle: 'alice', displayName: 'Alice Maker', status: 'covered', tweetCount: 2, notes: [] },
      { seedId: 'seed-2', handle: 'bob', displayName: 'Bob Chen', status: 'no_tweets_found', tweetCount: 0, notes: ['No qualifying tweets were returned for the last 24 hours.'] },
    ],
    items: [
      {
        tweetId: '190001',
        username: 'alice',
        displayName: 'Alice Maker',
        createdAt: '2026-03-23T01:02:03Z',
        text: 'Shipped a new CLI',
        originalUrl: 'https://x.com/alice/status/190001',
        batchId: 'batch-1',
        source: { seedId: 'seed-1' },
      },
    ],
    warnings: [],
  });
  assert.match(block, /"tweet_id": "190001"/);
  assert.match(block, /"status": "no_tweets_found"/);
});

test('runFetch smoke: writes fetch.input.json, fetch.raw.json, fetch.raw.csv and fetch.result.json from a controlled completion', async () => {
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
    assert.equal(join(result.runDir, 'fetch.input.json'), result.fetchInputPath);
    assert.equal(join(result.runDir, 'fetch.raw.json'), result.fetchRawPath);
    assert.equal(join(result.runDir, 'fetch.raw.csv'), result.fetchRawCsvPath);
    assert.equal(join(result.runDir, 'fetch.result.json'), result.fetchResultPath);

    const fetchInput = await readJson(result.fetchInputPath);
    assert.equal(fetchInput.task.sourceCsvPath, join(fixture.skillRoot, 'seed.csv'));
    assert.equal(fetchInput.task.seedCount, 2);
    assert.equal(fetchInput.task.timeWindowHours, 24);
    assert.equal(fetchInput.seeds[0].handle, 'alice');

    const fetchRaw = await readJson(result.fetchRawPath);
    assert.equal(fetchRaw.batches.length, 1);
    assert.equal(fetchRaw.batches[0].seedIds[0], 'seed-1');
    assert.equal(fetchRaw.batches[0].parseError, null);

    const fetchRawCsv = await readText(result.fetchRawCsvPath);
    assert.match(fetchRawCsv, /^username,tweet_id,created_at,text,original_url/m);
    assert.match(fetchRawCsv, /190001/);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.sourceProvider, 'grok');
    assert.equal(fetchResult.meta.seedCount, 2);
    assert.equal(fetchResult.meta.tweetCount, 2);
    assert.equal(fetchResult.meta.parseErrorCount, 0);
    assert.equal(fetchResult.accounts[0].status, 'covered');
    assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');
    assert.equal(fetchResult.items[0].source.seedId, 'seed-1');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch ignores prose/no-data rows mixed into CSV output without unmatched warnings', async () => {
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
    assert.equal(fetchResult.accounts[0].tweetCount, 1);
    assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch excludes tweets outside the deterministic 24h window from fetch.result.json and fetch.raw.csv', async () => {
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
    assert.equal(fetchResult.items.length, 1);
    assert.equal(fetchResult.items[0].tweetId, '190011');
    assert.equal(fetchResult.items.some((item) => item.tweetId === '190012'), false);
    assert.equal(fetchResult.warnings.some((warning) => warning.type === 'tweet_outside_time_window'), true);
    assert.equal(fetchResult.accounts[0].status, 'incomplete');
    assert.equal(fetchResult.accounts[0].tweetCount, 1);
    assert.equal(fetchResult.accounts[0].notes.some((note) => note.includes('outside the configured time window')), true);
    assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch preserves malformed mapped rows as incomplete evidence instead of swallowing them into no_tweets_found', async () => {
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
      fetchImpl: createCompletionFetchSequence([
        emptyCsv,
        FIXTURE_TWEET_FETCH_RESPONSE,
        emptyCsv,
      ]),
    });

    assert.equal(result.tweetCount, 2);

    const fetchRaw = await readJson(result.fetchRawPath);
    assert.equal(fetchRaw.meta.initialBatchCount, 1);
    assert.equal(fetchRaw.meta.refetchRoundCount, 1);
    assert.equal(fetchRaw.meta.refetchedAccountCount, 2);
    assert.equal(fetchRaw.batches.length, 3);
    assert.equal(fetchRaw.batches[1].attemptKind, 'refetch');
    assert.equal(fetchRaw.batches[2].attemptKind, 'refetch');

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.executedBatchCount, 3);
    assert.equal(fetchResult.meta.refetchRoundCount, 1);
    assert.equal(fetchResult.meta.refetchedAccountCount, 2);
    assert.equal(fetchResult.meta.recoveredByRefetchCount, 1);
    assert.equal(fetchResult.meta.stayedNoTweetAccountCount, 1);
    assert.equal(fetchResult.meta.stayedIncompleteAccountCount, 0);
    assert.equal(fetchResult.meta.stayedFailedAccountCount, 0);
    assert.equal(fetchResult.accounts[0].status, 'covered');
    assert.equal(fetchResult.accounts[0].tweetCount, 2);
    assert.equal(fetchResult.accounts[0].initialStatus, 'no_tweets_found');
    assert.equal(fetchResult.accounts[0].wasRefetched, true);
    assert.equal(fetchResult.accounts[0].recoveredByRefetch, true);
    assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');
    assert.equal(fetchResult.accounts[1].wasRefetched, true);
    assert.equal(fetchResult.accounts[1].recoveredByRefetch, false);
    assert.equal(fetchResult.refetch.recoveredAccounts[0].handle, 'alice');
    assert.equal(fetchResult.refetch.stayedNoTweetAccounts[0].handle, 'bob');
    assert.equal(fetchResult.warnings.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch records unresolved incomplete and failed accounts after refetch in fetch.result.json', async () => {
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
    assert.equal(fetchResult.meta.stayedNoTweetAccountCount, 0);
    assert.equal(fetchResult.meta.stayedIncompleteAccountCount, 1);
    assert.equal(fetchResult.meta.stayedFailedAccountCount, 1);
    assert.equal(fetchResult.accounts[0].handle, 'alice');
    assert.equal(fetchResult.accounts[0].status, 'incomplete');
    assert.equal(fetchResult.accounts[0].wasRefetched, true);
    assert.equal(fetchResult.accounts[1].handle, 'bob');
    assert.equal(fetchResult.accounts[1].status, 'fetch_failed');
    assert.equal(fetchResult.accounts[1].wasRefetched, true);
    assert.equal(fetchResult.refetch.stayedIncompleteAccounts[0].handle, 'alice');
    assert.equal(fetchResult.refetch.stayedFailedAccounts[0].handle, 'bob');
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
    assert.equal(result.failedAccountCount, 2);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.accounts[0].status, 'fetch_failed');
    assert.equal(fetchResult.accounts[1].status, 'fetch_failed');
    assert.equal(fetchResult.warnings[0].type, 'batch_parse_error');
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze smoke: consumes tweet evidence and writes analyze artifacts plus final.md', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const fetchSummary = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetch(FIXTURE_ANALYZE_MARKDOWN),
    });

    assert.equal(analyzeSummary.runDir, fetchSummary.runDir);
    assert.equal(analyzeSummary.analysisProfile, 'gpt-default');
    assert.equal(join(analyzeSummary.runDir, 'analyze.input.json'), analyzeSummary.analyzeInputPath);
    assert.equal(join(analyzeSummary.runDir, 'analyze.result.json'), analyzeSummary.analyzeResultPath);
    assert.equal(join(analyzeSummary.runDir, 'final.md'), analyzeSummary.finalReportPath);

    const analyzeInput = await readJson(analyzeSummary.analyzeInputPath);
    assert.equal(analyzeInput.task.analysisProfile, 'gpt-default');
    assert.equal(analyzeInput.task.goal, 'Screen the last 24 hours of X tweets into an editorial daily brief');
    assert.equal(analyzeInput.evidence.items.length, 2);
    assert.equal(analyzeInput.evidence.accounts[1].status, 'no_tweets_found');

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.meta.analysisProfile, 'gpt-default');
    assert.equal(analyzeResult.meta.provider, 'gpt');
    assert.equal(analyzeResult.meta.model, 'gpt-5.4(xhigh)');
    assert.equal(analyzeResult.meta.tweetCount, 2);
    assert.equal(analyzeResult.meta.coverage.failedAccountCount, 0);
    assert.equal(analyzeResult.answer.markdown, FIXTURE_ANALYZE_MARKDOWN);
    assert.equal(analyzeResult.quality.needsReview, false);

    const finalReport = await readText(analyzeSummary.finalReportPath);
    assert.equal(finalReport, FIXTURE_ANALYZE_MARKDOWN);
  } finally {
    await fixture.cleanup();
  }
});

test('runActivityPrecheck filters dormant accounts and keeps active ones', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
    const precheckPromptPath = join(fixture.skillRoot, 'assets', 'prompts', 'grok-precheck.txt');
    const result = await runActivityPrecheck({
      seeds,
      profile: {
        provider: { baseUrl: 'https://grok.example/v1', apiKey: 'grok-key' },
        model: 'grok-4.1-fast',
        retry: { maxAttempts: 1, backoffMs: 50 },
      },
      fetchImpl: createCompletionFetch(FIXTURE_PRECHECK_RESPONSE_DORMANT),
      referenceTime: FIXTURE_REFERENCE_TIME,
      precheckConfig: {
        enabled: true,
        dormantThresholdDays: 7,
        batchSize: 10,
        timeoutMs: 5000,
        maxOutputTokens: 500,
        promptFile: precheckPromptPath,
      },
    });

    assert.equal(result.activeSeeds.length, 1);
    assert.equal(result.activeSeeds[0].handle, 'alice');
    assert.equal(result.dormantSeeds.length, 1);
    assert.equal(result.dormantSeeds[0].handle, 'bob');
    assert.equal(result.dormantSeeds[0].status, 'dormant_skipped');
    assert.ok(result.dormantSeeds[0].daysSinceLastTweet > 7);
  } finally {
    await fixture.cleanup();
  }
});

test('runActivityPrecheck treats all accounts as active when all have recent tweets', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
    const precheckPromptPath = join(fixture.skillRoot, 'assets', 'prompts', 'grok-precheck.txt');
    const result = await runActivityPrecheck({
      seeds,
      profile: {
        provider: { baseUrl: 'https://grok.example/v1', apiKey: 'grok-key' },
        model: 'grok-4.1-fast',
        retry: { maxAttempts: 1, backoffMs: 50 },
      },
      fetchImpl: createCompletionFetch(FIXTURE_PRECHECK_RESPONSE_ALL_ACTIVE),
      referenceTime: FIXTURE_REFERENCE_TIME,
      precheckConfig: {
        enabled: true,
        dormantThresholdDays: 7,
        batchSize: 10,
        timeoutMs: 5000,
        maxOutputTokens: 500,
        promptFile: precheckPromptPath,
      },
    });

    assert.equal(result.activeSeeds.length, 2);
    assert.equal(result.dormantSeeds.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('runActivityPrecheck fails open: treats accounts as active on parse failure', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
    const precheckPromptPath = join(fixture.skillRoot, 'assets', 'prompts', 'grok-precheck.txt');
    const result = await runActivityPrecheck({
      seeds,
      profile: {
        provider: { baseUrl: 'https://grok.example/v1', apiKey: 'grok-key' },
        model: 'grok-4.1-fast',
        retry: { maxAttempts: 1, backoffMs: 50 },
      },
      fetchImpl: createCompletionFetch('Sorry, I cannot process this request.'),
      referenceTime: FIXTURE_REFERENCE_TIME,
      precheckConfig: {
        enabled: true,
        dormantThresholdDays: 7,
        batchSize: 10,
        timeoutMs: 5000,
        maxOutputTokens: 500,
        promptFile: precheckPromptPath,
      },
    });

    assert.equal(result.activeSeeds.length, 2);
    assert.equal(result.dormantSeeds.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch with precheck enabled skips dormant accounts and records them in fetch.result.json', async () => {
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
      const content = callIndex === 1
        ? FIXTURE_PRECHECK_RESPONSE_DORMANT
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

    assert.equal(result.seedCount, 2);
    assert.equal(result.activeSeedCount, 1);
    assert.equal(result.dormantSeedCount, 1);
    assert.equal(result.dormantSkippedAccountCount, 1);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.precheckEnabled, true);
    assert.equal(fetchResult.meta.activeSeedCount, 1);
    assert.equal(fetchResult.meta.dormantSeedCount, 1);
    assert.equal(fetchResult.meta.precheckActiveCount, 1);
    assert.equal(fetchResult.meta.precheckDormantCount, 1);

    const dormantAccount = fetchResult.accounts.find((a) => a.status === 'dormant_skipped');
    assert.ok(dormantAccount);
    assert.equal(dormantAccount.handle, 'bob');
    assert.ok(dormantAccount.daysSinceLastTweet > 7);
  } finally {
    await fixture.cleanup();
  }
});

test('runFetch with --skip-precheck bypasses precheck and fetches all accounts', async () => {
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
    assert.equal(result.dormantSkippedAccountCount, 0);

    const fetchResult = await readJson(result.fetchResultPath);
    assert.equal(fetchResult.meta.precheckEnabled, false);
    assert.equal(fetchResult.meta.dormantSeedCount, 0);
    assert.equal(fetchResult.accounts.filter((a) => a.status === 'dormant_skipped').length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze continues when LLM response is truncated and concatenates parts', async () => {
  const fixture = await createMockSkillFixture();
  try {
    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const analyzeFetch = createCompletionFetchSequenceWithFinishReason([
      { content: FIXTURE_ANALYZE_MARKDOWN_PART1, finishReason: 'length' },
      { content: FIXTURE_ANALYZE_MARKDOWN_PART2, finishReason: 'stop' },
    ]);

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: analyzeFetch,
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.meta.continuationRounds, 1);
    assert.equal(analyzeResult.meta.truncated, false);

    const expectedCombined = FIXTURE_ANALYZE_MARKDOWN_PART1 + FIXTURE_ANALYZE_MARKDOWN_PART2;
    assert.equal(analyzeResult.answer.markdown, expectedCombined);
    assert.match(analyzeResult.answer.markdown, /今日要点摘要/);
    assert.match(analyzeResult.answer.markdown, /抓取覆盖与缺口/);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze stops after maxContinuations and marks result as truncated', async () => {
  const fixture = await createMockSkillFixture();
  try {
    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const analyzeFetch = createCompletionFetchSequenceWithFinishReason([
      { content: 'Part 1. ', finishReason: 'length' },
      { content: 'Part 2. ', finishReason: 'length' },
      { content: 'Part 3.', finishReason: 'length' },
    ]);

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: analyzeFetch,
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.meta.continuationRounds, 2);
    assert.equal(analyzeResult.meta.truncated, true);
    assert.match(analyzeResult.answer.markdown, /Part 1/);
    assert.match(analyzeResult.answer.markdown, /Part 2/);
    assert.match(analyzeResult.answer.markdown, /Part 3/);
  } finally {
    await fixture.cleanup();
  }
});
