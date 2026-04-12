import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { runFetch } from '../scripts/fetch.mjs';
import { runAnalyze } from '../scripts/analyze.mjs';
import {
  FIXTURE_ANALYZE_MARKDOWN,
  FIXTURE_ANALYZE_MARKDOWN_PART1,
  FIXTURE_ANALYZE_MARKDOWN_PART2,
  FIXTURE_REFERENCE_TIME,
  FIXTURE_TWEET_FETCH_RESPONSE,
  createCompletionFetch,
  createCompletionFetchSequence,
  createCompletionFetchSequenceWithFinishReason,
  createCompletionResponse,
  createMockSkillFixture,
  readJson,
  readText,
} from '../support/fixtures.mjs';

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test('repo analysis profiles keep timeout above the known live-run failure threshold', async () => {
  const repoConfig = await readJson(fileURLToPath(new URL('../config.json', import.meta.url)));
  const exampleConfig = await readJson(fileURLToPath(new URL('../config.example.json', import.meta.url)));

  for (const [label, config] of [['config.json', repoConfig], ['config.example.json', exampleConfig]]) {
    assert.ok(config.analysis.profiles['gpt-default'].timeoutMs > 90000, `${label} gpt-default timeoutMs must stay above 90000ms`);
    assert.ok(config.analysis.profiles['claude-default'].timeoutMs > 90000, `${label} claude-default timeoutMs must stay above 90000ms`);
    assert.equal(config.analysis.profiles['gpt-default'].rosterModelRef, 'gpt-main-mini');
    assert.equal(config.analysis.profiles['gpt-default'].screeningModelRef, 'gpt-main-mini');
    assert.equal(config.models['gpt-main-mini'].providerRef, 'gpt');
    assert.equal(config.models['gpt-main-mini'].modelId, 'gpt-5.4');
  }
});

test('runAnalyze smoke consumes tweet evidence and writes analyze artifacts plus final report', async () => {
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

    assert.equal(analyzeSummary.analysisProfile, 'gpt-default');
    assert.equal(join(analyzeSummary.runDir, 'analyze.input.json'), analyzeSummary.analyzeInputPath);
    assert.equal(join(analyzeSummary.runDir, 'analyze.result.json'), analyzeSummary.analyzeResultPath);
    assert.equal(join(analyzeSummary.runDir, 'final.md'), analyzeSummary.finalReportPath);

    const analyzeInput = await readJson(analyzeSummary.analyzeInputPath);
    assert.equal(analyzeInput.task.analysisProfile, 'gpt-default');
    assert.equal(analyzeInput.evidence.meta.fetchInputPath, fetchSummary.fetchInputPath);
    assert.equal(analyzeInput.evidence.meta.fetchRawPath, fetchSummary.fetchRawPath);
    assert.equal(analyzeInput.evidence.meta.fetchRawCsvPath, fetchSummary.fetchRawCsvPath);
    assert.equal(analyzeInput.evidence.items.length, 2);
    assert.equal(analyzeInput.evidence.accounts[1].status, 'no_tweets_found');

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.meta.analysisProfile, 'gpt-default');
    assert.equal(analyzeResult.meta.provider, 'gpt');
    assert.equal(analyzeResult.meta.model, 'gpt-5.4-xhigh');
    assert.equal(analyzeResult.meta.rosterModel, 'gpt-5.4');
    assert.equal(analyzeResult.meta.screeningModel, 'gpt-5.4');
    assert.equal(analyzeResult.meta.briefModel, 'gpt-5.4-xhigh');
    assert.equal(analyzeResult.meta.tweetCount, 2);
    assert.equal(analyzeResult.meta.coverage.failedAccountCount, 0);
    assert.equal(analyzeResult.meta.fetchDiagnosis.status, 'ready');
    assert.ok(analyzeResult.meta.finalDraftDurationMs >= 0);
    assert.ok(analyzeResult.meta.analyzeDurationMs >= analyzeResult.meta.finalDraftDurationMs);
    assert.equal(analyzeResult.answer.source, 'model');
    assert.equal(analyzeResult.answer.markdown, FIXTURE_ANALYZE_MARKDOWN);
    assert.equal(analyzeResult.quality.needsReview, false);
    assert.equal(analyzeSummary.finalDraftDurationMs, analyzeResult.meta.finalDraftDurationMs);
    assert.equal(analyzeSummary.analyzeDurationMs, analyzeResult.meta.analyzeDurationMs);

    const finalReport = await readText(analyzeSummary.finalReportPath);
    assert.equal(finalReport, FIXTURE_ANALYZE_MARKDOWN);
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
    assert.equal(analyzeResult.answer.markdown, FIXTURE_ANALYZE_MARKDOWN_PART1 + FIXTURE_ANALYZE_MARKDOWN_PART2);
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

test('runAnalyze can update roster scores via GPT before writing the daily brief', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.providers['gpt-backup'] = {
      configSource: { fileRef: 'openclaw', jsonPath: '$.models.providers.router-gpt-backup' },
      mapping: { baseUrl: 'baseUrl', apiKey: 'apiKey', models: 'models' },
    };
    config.models['gpt-main-mini'] = { providerRef: 'gpt-backup', modelId: 'gpt-5.4-mini' };
    config.analysis.profiles['gpt-default'].rosterModelRef = 'gpt-main-mini';
    config.roster = {
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
    };
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetchSequence([
        JSON.stringify([
          {
            handle: 'alice',
            high_value_tweet_count: 1,
            low_value_chat_count: 0,
            reason: 'Useful tooling updates.',
          },
        ]),
        FIXTURE_ANALYZE_MARKDOWN,
      ]),
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.meta.rosterScoring.scoredAccountCount, 1);
    assert.equal(analyzeResult.meta.rosterModel, 'gpt-5.4-mini');
    assert.equal(analyzeResult.meta.briefModel, 'gpt-5.4-xhigh');

    const scoreState = await readJson(join(fixture.skillRoot, 'account-score.json'));
    const alice = scoreState.accounts.find((entry) => entry.handle === 'alice');
    assert.equal(alice.score, 4);
    assert.equal(alice.tier, 'daily');
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze overlaps roster scoring with screening before the final brief', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.roster = {
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
    };
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const runDate = '2026-03-23';
    const fetchRunDir = join(fixture.skillRoot, 'data', runDate, 'run-000001');
    await mkdir(fetchRunDir, { recursive: true });

    const baseTimeMs = Date.parse('2026-03-23T12:00:00Z');
    const items = Array.from({ length: 50 }, (_, index) => {
      const handle = index % 2 === 0 ? 'alice' : 'bob';
      return {
        tweetId: `19${String(index + 1).padStart(4, '0')}`,
        username: handle,
        displayName: handle === 'alice' ? 'Alice Maker' : 'Bob Chen',
        createdAt: new Date(baseTimeMs - (index * 60 * 1000)).toISOString(),
        text: `${handle} shipped an agent workflow update with benchmark notes and docs https://example.com/${handle}/${index + 1}`,
        originalUrl: `https://x.com/${handle}/status/19${String(index + 1).padStart(4, '0')}`,
        batchId: 'batch-1',
        source: { seedId: handle === 'alice' ? 'seed-1' : 'seed-2' },
      };
    });
    const accounts = [
      {
        seedId: 'seed-1',
        handle: 'alice',
        displayName: 'Alice Maker',
        userPageUrl: 'https://x.com/alice',
        status: 'covered',
        tweetCount: 25,
        notes: [],
      },
      {
        seedId: 'seed-2',
        handle: 'bob',
        displayName: 'Bob Chen',
        userPageUrl: 'https://x.com/bob',
        status: 'covered',
        tweetCount: 25,
        notes: [],
      },
    ];
    const fetchResult = {
      meta: {
        sourceProvider: 'grok',
        fetchedAt: FIXTURE_REFERENCE_TIME,
        windowStartUtc: '2026-03-22T14:21:05.770Z',
        windowEndUtc: FIXTURE_REFERENCE_TIME,
        sourceCsvPath: join(fixture.skillRoot, 'seed.csv'),
        timeWindowHours: 24,
        fetchInputPath: join(fetchRunDir, 'fetch.input.json'),
        fetchRawPath: join(fetchRunDir, 'fetch.raw.json'),
        fetchRawCsvPath: join(fetchRunDir, 'fetch.raw.csv'),
      },
      accounts,
      items,
      warnings: [],
    };
    await writeFile(join(fetchRunDir, 'fetch.result.json'), JSON.stringify(fetchResult, null, 2));

    const scoringGate = createDeferred();
    let scoringRequestSeen = false;
    let scoringResolved = false;
    let screeningRequestCount = 0;
    let overlapObserved = false;
    const requestKinds = [];
    const analyzeFetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const prompt = String(body.messages?.[0]?.content ?? body.input?.[0]?.content ?? '');

      if (prompt.startsWith('Score roster accounts')) {
        scoringRequestSeen = true;
        if (screeningRequestCount > 0 && !scoringResolved) overlapObserved = true;
        requestKinds.push('roster');
        await scoringGate.promise;
        scoringResolved = true;
        return createCompletionResponse(JSON.stringify([
          {
            handle: 'alice',
            high_value_tweet_count: 1,
            low_value_chat_count: 0,
            reason: 'Useful tooling updates.',
          },
        ]), body);
      }

      if (prompt.includes('你是一位信息流筛选编辑')) {
        screeningRequestCount += 1;
        if (scoringRequestSeen && !scoringResolved) overlapObserved = true;
        if (screeningRequestCount === 1) scoringGate.resolve();
        requestKinds.push(`screening-${screeningRequestCount}`);
        const tweetIds = [...prompt.matchAll(/"tweet_id":\s*"([^"]+)"/g)].map((match) => match[1]);
        const response = screeningRequestCount === 1
          ? JSON.stringify([
            { tweet_id: tweetIds[0], handle: 'alice', priority: 3, reason: 'chunk1 高价值候选。' },
            { tweet_id: tweetIds[1], handle: 'bob', priority: 2, reason: 'chunk1 补充候选。' },
          ])
          : JSON.stringify([
            { tweet_id: tweetIds[0], handle: 'alice', priority: 3, reason: 'chunk2 高价值候选。' },
          ]);
        return createCompletionResponse(response, body);
      }

      if (prompt.startsWith('Analyze tweets for')) {
        requestKinds.push('final');
        return createCompletionResponse(FIXTURE_ANALYZE_MARKDOWN, body);
      }

      throw new Error(`Unexpected analyze prompt: ${prompt.slice(0, 60)}`);
    };

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: runDate,
      fetchImpl: analyzeFetch,
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(overlapObserved, true);
    assert.equal(screeningRequestCount, 2);
    assert.equal(requestKinds.at(-1), 'final');
    assert.ok(requestKinds.includes('roster'));
    assert.equal(requestKinds.filter((kind) => kind.startsWith('screening-')).length, 2);
    assert.equal(analyzeResult.meta.screeningChunkCount, 2);
    assert.equal(analyzeResult.meta.screeningCandidateCount, 3);
    assert.equal(analyzeResult.meta.rosterScoring.scoredAccountCount, 1);

    const scoreState = await readJson(join(fixture.skillRoot, 'account-score.json'));
    const alice = scoreState.accounts.find((entry) => entry.handle === 'alice');
    assert.equal(alice.score, 4);
    assert.equal(alice.tier, 'daily');
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze writes a readable structured fallback brief when the GPT brief is empty', async () => {
  const fixture = await createMockSkillFixture();
  try {
    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetch(''),
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.answer.source, 'fallback');
    assert.equal(analyzeResult.meta.fetchDiagnosis.status, 'ready');
    assert.match(analyzeResult.answer.markdown, /今日要点摘要/);
    assert.match(analyzeResult.answer.markdown, /高价值推文完整清单/);
    assert.match(analyzeResult.answer.markdown, /https:\/\/x\.com\/alice\/status\/190001/);

    const finalReport = await readText(analyzeSummary.finalReportPath);
    assert.match(finalReport, /编辑精选/);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze fallback brief keeps multiline tweet summaries readable', async () => {
  const fixture = await createMockSkillFixture();
  const multilineFetchResponse = [
    '```csv',
    'username,tweet_id,created_at,text,original_url',
    '"alice","190001","2026-03-23T01:02:03Z","Line one.',
    'Line two with more context.","https://x.com/alice/status/190001"',
    '```',
  ].join('\n');

  try {
    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(multilineFetchResponse),
    });

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetch(''),
    });

    const finalReport = await readText(analyzeSummary.finalReportPath);
    assert.match(finalReport, /Line one\.\s+Line two with more context\./);
    assert.doesNotMatch(finalReport, /\\n/);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze falls back when the GPT brief is structurally weak despite being non-empty', async () => {
  const fixture = await createMockSkillFixture();
  const weakMarkdown = [
    '# X 日报 | 2026-03-23',
    '',
    '## 今日摘要',
    '',
    '## 高价值推文',
    '',
    '`@alice`',
    '',
    '链接：<https://x.com/alice/status/190001>',
    '',
    '`@alice`',
    '',
    '链接：<https://x.com/alice/status/190002>',
    '',
    '## 覆盖与风险',
    '',
    '`@bob`',
  ].join('\n');

  try {
    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetch(weakMarkdown),
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.answer.source, 'fallback');
    assert.match(analyzeResult.answer.markdown, /今日要点摘要/);
    assert.match(analyzeResult.answer.markdown, /编辑精选/);
    assert.match(analyzeResult.answer.markdown, /高价值推文完整清单/);
    assert.match(analyzeResult.answer.markdown, /Shipped a new CLI for tracing agent runs/);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze retries final draft with a fallback brief model when the primary model is unavailable', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.analysis.profiles['gpt-default'].briefFallbackModelRef = 'gpt-main-mini';
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const requests = [];
    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options?.body ?? '{}');
        requests.push(body);
        if (body.model === 'gpt-5.4-xhigh') {
          return {
            ok: false,
            status: 503,
            headers: {},
            text: async () => '{"error":{"message":"Service temporarily unavailable","type":"api_error"}}',
          };
        }
        return createCompletionResponse(FIXTURE_ANALYZE_MARKDOWN, body);
      },
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.answer.source, 'model');
    assert.equal(analyzeResult.meta.briefModel, 'gpt-5.4');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, 'gpt-5.4-xhigh');
    assert.equal(requests[1].model, 'gpt-5.4');

    const finalReport = await readText(analyzeSummary.finalReportPath);
    assert.equal(finalReport, FIXTURE_ANALYZE_MARKDOWN);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze preserves a final-draft diagnostic artifact and falls back to a readable brief when the request fails', async () => {
  const fixture = await createMockSkillFixture();
  try {
    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: async () => {
        const networkCause = new Error('socket hang up');
        networkCause.code = 'ECONNRESET';
        const requestError = new TypeError('fetch failed');
        requestError.cause = networkCause;
        throw requestError;
      },
    });

    const analyzeError = await readJson(join(analyzeSummary.runDir, 'analyze.error.json'));
    assert.equal(analyzeError.stage, 'final_draft');
    assert.equal(analyzeError.analysisProfile, 'gpt-default');
    assert.equal(analyzeError.briefModel, 'gpt-5.4-xhigh');
    assert.equal(analyzeError.candidateSelectionMode, 'direct_heuristic');
    assert.equal(analyzeError.screeningChunkCount, 0);
    assert.equal(analyzeError.promptSignalTweetCount, 2);
    assert.equal(analyzeError.error.classification, 'network_error');
    assert.equal(analyzeError.error.code, 'ECONNRESET');
    assert.equal(analyzeError.error.operationName, 'analyze_round:0');
    assert.match(analyzeError.error.targetPath, /\/responses$/);
    assert.equal(analyzeError.error.retry.maxAttempts, 1);
    assert.equal(analyzeError.error.retry.exhausted, true);
    assert.equal(analyzeError.error.continuation.failedRound, 0);
    assert.equal(analyzeError.error.continuation.completedContinuationRounds, 0);
    assert.equal(analyzeError.error.causeChain[0].code, 'ECONNRESET');

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.answer.source, 'fallback');
    assert.match(analyzeResult.answer.markdown, /今日要点摘要/);
    assert.match(analyzeResult.answer.markdown, /https:\/\/x\.com\/alice\/status\/190001/);

    const finalReport = await readText(analyzeSummary.finalReportPath);
    assert.match(finalReport, /高价值推文完整清单/);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze reuses the latest available fetch run even when a newer analyze-only run exists', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const fetchSummary = await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetch(FIXTURE_ANALYZE_MARKDOWN),
    });

    const secondAnalyze = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetch(FIXTURE_ANALYZE_MARKDOWN),
    });

    const analyzeInput = await readJson(secondAnalyze.analyzeInputPath);
    assert.equal(analyzeInput.evidence.meta.fetchInputPath, fetchSummary.fetchInputPath);
    assert.equal(analyzeInput.evidence.meta.fetchRawPath, fetchSummary.fetchRawPath);
    assert.equal(analyzeInput.evidence.meta.fetchRawCsvPath, fetchSummary.fetchRawCsvPath);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze can resume from analyze.input.json and only rerun the final brief stage', async () => {
  const fixture = await createMockSkillFixture();
  try {
    await runFetch({
      configPath: fixture.configPath,
      date: '2026-03-23',
      referenceTime: FIXTURE_REFERENCE_TIME,
      fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
    });

    const initialAnalyze = await runAnalyze({
      configPath: fixture.configPath,
      date: '2026-03-23',
      fetchImpl: createCompletionFetch(FIXTURE_ANALYZE_MARKDOWN),
    });

    const storedAnalyzeInput = await readJson(initialAnalyze.analyzeInputPath);
    assert.equal(storedAnalyzeInput.task.promptItems.length, 2);

    const requests = [];
    const resumedAnalyze = await runAnalyze({
      configPath: fixture.configPath,
      analyzeInputPath: initialAnalyze.analyzeInputPath,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return createCompletionResponse({ content: FIXTURE_ANALYZE_MARKDOWN_PART2, finishReason: 'stop' }, body);
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'gpt-5.4-xhigh');
    assert.equal(requests[0].stream, true);
    assert.equal(resumedAnalyze.runDir, initialAnalyze.runDir);

    const finalReport = await readText(resumedAnalyze.finalReportPath);
    assert.equal(finalReport, FIXTURE_ANALYZE_MARKDOWN_PART2.trim());
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze screens large signal sets in chunks before generating the final brief', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.providers['gpt-backup'] = {
      configSource: { fileRef: 'openclaw', jsonPath: '$.models.providers.router-gpt-backup' },
      mapping: { baseUrl: 'baseUrl', apiKey: 'apiKey', models: 'models' },
    };
    config.models['gpt-main-mini'] = { providerRef: 'gpt-backup', modelId: 'gpt-5.4-mini' };
    config.analysis.profiles['gpt-default'].screeningModelRef = 'gpt-main-mini';
    config.analysis.profiles['gpt-default'].rosterModelRef = 'gpt-main-mini';
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const runDate = '2026-03-23';
    const fetchRunDir = join(fixture.skillRoot, 'data', runDate, 'run-000001');
    await mkdir(fetchRunDir, { recursive: true });

    const baseTimeMs = Date.parse('2026-03-23T12:00:00Z');
    const items = Array.from({ length: 50 }, (_, index) => {
      const handleIndex = Math.floor(index / 2) + 1;
      const handle = `account${String(handleIndex).padStart(2, '0')}`;
      const itemSuffix = String(index + 1).padStart(2, '0');
      return {
        tweetId: `19${String(index + 1).padStart(4, '0')}`,
        username: handle,
        displayName: `Account ${handleIndex}`,
        createdAt: new Date(baseTimeMs - (index * 60 * 1000)).toISOString(),
        text: `${handle} shipped an agent workflow update with benchmark notes and docs https://example.com/${handle}/${itemSuffix}`,
        originalUrl: `https://x.com/${handle}/status/19${String(index + 1).padStart(4, '0')}`,
        batchId: 'batch-1',
        source: { seedId: `seed-${handleIndex}` },
      };
    });
    const accounts = Array.from({ length: 25 }, (_, index) => ({
      seedId: `seed-${index + 1}`,
      handle: `account${String(index + 1).padStart(2, '0')}`,
      displayName: `Account ${index + 1}`,
      userPageUrl: `https://x.com/account${String(index + 1).padStart(2, '0')}`,
      status: 'covered',
      tweetCount: 2,
      notes: [],
    }));
    const fetchResult = {
      meta: {
        sourceProvider: 'grok',
        fetchedAt: FIXTURE_REFERENCE_TIME,
        windowStartUtc: '2026-03-22T14:21:05.770Z',
        windowEndUtc: FIXTURE_REFERENCE_TIME,
        sourceCsvPath: join(fixture.skillRoot, 'seed.csv'),
        timeWindowHours: 24,
        includeTweetTypes: ['original', 'repost', 'quote'],
        excludePureReplies: true,
        seedCount: 25,
        activeSeedCount: 25,
        dormantSeedCount: 0,
        precheckEnabled: false,
        precheckActiveCount: 25,
        precheckDormantCount: 0,
        batchSize: 25,
        batchCount: 1,
        executedBatchCount: 1,
        refetchRoundCount: 0,
        refetchedAccountCount: 0,
        tweetCount: items.length,
        fetchInputPath: join(fetchRunDir, 'fetch.input.json'),
        fetchRawPath: join(fetchRunDir, 'fetch.raw.json'),
        fetchRawCsvPath: join(fetchRunDir, 'fetch.raw.csv'),
        fetchTweetIndexCsvPath: join(fetchRunDir, 'fetch.tweet-index.csv'),
        parseErrorCount: 0,
        coveredAccountCount: 25,
        noTweetAccountCount: 0,
        failedAccountCount: 0,
        softFailedAccountCount: 0,
        dormantSkippedAccountCount: 0,
        incompleteAccountCount: 0,
        recoveredByRefetchCount: 0,
        stayedNoTweetAccountCount: 0,
        stayedIncompleteAccountCount: 0,
        stayedFailedAccountCount: 0,
        stayedSoftFailedAccountCount: 0,
        warningCount: 0,
        durationMs: 1000,
      },
      accounts,
      items,
      warnings: [],
    };
    await writeFile(join(fetchRunDir, 'fetch.result.json'), JSON.stringify(fetchResult, null, 2));

    const requests = [];
    const responses = [
      JSON.stringify([
        { tweet_id: '190001', handle: 'account01', priority: 3, reason: '值得入选 chunk1 候选。' },
        { tweet_id: '190002', handle: 'account01', priority: 2, reason: '同账号第二条高价值。' },
        { tweet_id: '190003', handle: 'account02', priority: 2, reason: '方法论更新。' },
        { tweet_id: '190004', handle: 'account02', priority: 1, reason: '补充候选。' },
      ]),
      JSON.stringify([
        { tweet_id: '190049', handle: 'account25', priority: 3, reason: 'chunk2 重点候选。' },
        { tweet_id: '190050', handle: 'account25', priority: 2, reason: 'chunk2 补充候选。' },
      ]),
      JSON.stringify([
        {
          headline: '账号 1-2 的工具与方法论更新',
          summary: '这一组主要是工具发布和方法论补充，适合进入最终日报。',
          tweet_ids: ['190001', '190002', '190003', '190004'],
          handles: ['account01', 'account02'],
        },
      ]),
      JSON.stringify([
        {
          headline: '账号 25 的重点更新',
          summary: '这一组提供了第二个主题线索，适合在成稿中独立呈现。',
          tweet_ids: ['190049', '190050'],
          handles: ['account25'],
        },
      ]),
      FIXTURE_ANALYZE_MARKDOWN,
    ];
    let responseIndex = 0;
    const analyzeFetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const content = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;
      return createCompletionResponse({ content, finishReason: 'stop' }, body);
    };

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: runDate,
      fetchImpl: analyzeFetch,
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.meta.candidateSelectionMode, 'chunked_llm');
    assert.equal(analyzeResult.meta.screeningChunkCount, 2);
    assert.equal(analyzeResult.meta.screeningCandidateCount, 6);
    assert.equal(analyzeResult.meta.promptSignalTweetCount, 6);
    assert.equal(analyzeResult.meta.omittedSignalTweetCount, 44);
    assert.equal(analyzeResult.meta.screeningModel, 'gpt-5.4-mini');
    assert.equal(analyzeResult.meta.briefModel, 'gpt-5.4-xhigh');

    assert.equal(requests.length, 5);
    assert.equal(requests[0].model, 'gpt-5.4-mini');
    assert.equal(requests[1].model, 'gpt-5.4-mini');
    assert.equal(requests[2].model, 'gpt-5.4-mini');
    assert.equal(requests[3].model, 'gpt-5.4-mini');
    assert.equal(requests[4].model, 'gpt-5.4-xhigh');
    assert.equal(requests[0].stream, false);
    assert.equal(requests[1].stream, false);
    assert.equal(requests[2].stream, false);
    assert.equal(requests[3].stream, false);
    assert.equal(requests[4].stream, true);
    const finalPrompt = String(requests[4].messages?.[0]?.content ?? requests[4].input?.[0]?.content ?? '');
    assert.ok((finalPrompt.match(/"tweet_id":/g) ?? []).length > 4);
    assert.match(finalPrompt, /"summary_chunks":/);
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze keeps brief quality healthy when digest summary LLM chunks fall back locally', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.providers['gpt-backup'] = {
      configSource: { fileRef: 'openclaw', jsonPath: '$.models.providers.router-gpt-backup' },
      mapping: { baseUrl: 'baseUrl', apiKey: 'apiKey', api: 'api', models: 'models' },
    };
    config.models['gpt-main-mini'] = { providerRef: 'gpt-backup', modelId: 'gpt-5.4-mini' };
    config.analysis.profiles['gpt-default'].screeningModelRef = 'gpt-main-mini';
    config.analysis.profiles['gpt-default'].rosterModelRef = 'gpt-main-mini';
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const runDate = '2026-03-23';
    const fetchRunDir = join(fixture.skillRoot, 'data', runDate, 'run-000001');
    await mkdir(fetchRunDir, { recursive: true });

    const baseTimeMs = Date.parse('2026-03-23T12:00:00Z');
    const items = Array.from({ length: 50 }, (_, index) => {
      const handleIndex = Math.floor(index / 2) + 1;
      const handle = `account${String(handleIndex).padStart(2, '0')}`;
      const itemSuffix = String(index + 1).padStart(2, '0');
      return {
        tweetId: `19${String(index + 1).padStart(4, '0')}`,
        username: handle,
        displayName: `Account ${handleIndex}`,
        createdAt: new Date(baseTimeMs - (index * 60 * 1000)).toISOString(),
        text: `${handle} shipped an agent workflow update with benchmark notes and docs https://example.com/${handle}/${itemSuffix}`,
        originalUrl: `https://x.com/${handle}/status/19${String(index + 1).padStart(4, '0')}`,
        batchId: 'batch-1',
        source: { seedId: `seed-${handleIndex}` },
      };
    });
    const accounts = Array.from({ length: 25 }, (_, index) => ({
      seedId: `seed-${index + 1}`,
      handle: `account${String(index + 1).padStart(2, '0')}`,
      displayName: `Account ${index + 1}`,
      userPageUrl: `https://x.com/account${String(index + 1).padStart(2, '0')}`,
      status: 'covered',
      tweetCount: 2,
      notes: [],
    }));
    const fetchResult = {
      meta: {
        sourceProvider: 'grok',
        fetchedAt: FIXTURE_REFERENCE_TIME,
        windowStartUtc: '2026-03-22T14:21:05.770Z',
        windowEndUtc: FIXTURE_REFERENCE_TIME,
        sourceCsvPath: join(fixture.skillRoot, 'seed.csv'),
        timeWindowHours: 24,
        includeTweetTypes: ['original', 'repost', 'quote'],
        excludePureReplies: true,
        seedCount: 25,
        activeSeedCount: 25,
        dormantSeedCount: 0,
        precheckEnabled: false,
        precheckActiveCount: 25,
        precheckDormantCount: 0,
        batchSize: 25,
        batchCount: 1,
        executedBatchCount: 1,
        refetchRoundCount: 0,
        refetchedAccountCount: 0,
        tweetCount: items.length,
        fetchInputPath: join(fetchRunDir, 'fetch.input.json'),
        fetchRawPath: join(fetchRunDir, 'fetch.raw.json'),
        fetchRawCsvPath: join(fetchRunDir, 'fetch.raw.csv'),
        fetchTweetIndexCsvPath: join(fetchRunDir, 'fetch.tweet-index.csv'),
        parseErrorCount: 0,
        coveredAccountCount: 25,
        noTweetAccountCount: 0,
        failedAccountCount: 0,
        softFailedAccountCount: 0,
        dormantSkippedAccountCount: 0,
        incompleteAccountCount: 0,
        recoveredByRefetchCount: 0,
        stayedNoTweetAccountCount: 0,
        stayedIncompleteAccountCount: 0,
        stayedFailedAccountCount: 0,
        stayedSoftFailedAccountCount: 0,
        warningCount: 0,
        durationMs: 1000,
      },
      accounts,
      items,
      warnings: [],
    };
    await writeFile(join(fetchRunDir, 'fetch.result.json'), JSON.stringify(fetchResult, null, 2));

    const requests = [];
    const analyzeFetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const prompt = String(body.messages?.[0]?.content ?? body.input?.[0]?.content ?? '');

      if (prompt.includes('你是一位信息流筛选编辑')) {
        const tweetIds = [...prompt.matchAll(/"tweet_id":\s*"([^"]+)"/g)].map((match) => match[1]);
        const response = tweetIds.includes('190049')
          ? JSON.stringify([
            { tweet_id: '190049', handle: 'account25', priority: 3, reason: 'chunk2 重点候选。' },
            { tweet_id: '190050', handle: 'account25', priority: 2, reason: 'chunk2 补充候选。' },
          ])
          : JSON.stringify([
            { tweet_id: '190001', handle: 'account01', priority: 3, reason: '值得入选 chunk1 候选。' },
            { tweet_id: '190002', handle: 'account01', priority: 2, reason: '同账号第二条高价值。' },
            { tweet_id: '190003', handle: 'account02', priority: 2, reason: '方法论更新。' },
            { tweet_id: '190004', handle: 'account02', priority: 1, reason: '补充候选。' },
          ]);
        return createCompletionResponse({ content: response, finishReason: 'stop' }, body);
      }

      if (prompt.includes('你是一位日报预编辑')) {
        throw new Error('summary provider protocol mismatch');
      }

      if (prompt.startsWith('Analyze tweets for')) {
        return createCompletionResponse({ content: FIXTURE_ANALYZE_MARKDOWN, finishReason: 'stop' }, body);
      }

      throw new Error(`Unexpected analyze prompt: ${prompt.slice(0, 60)}`);
    };

    const analyzeSummary = await runAnalyze({
      configPath: fixture.configPath,
      date: runDate,
      fetchImpl: analyzeFetch,
    });

    const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
    assert.equal(analyzeResult.meta.candidateSelectionMode, 'chunked_llm');
    assert.equal(analyzeResult.meta.summaryChunkCount, 2);
    assert.equal(analyzeResult.meta.summaryFailedChunkCount, 0);
    assert.ok(analyzeResult.meta.summaryItemCount > 0);
    assert.equal(analyzeResult.quality.status, 'ok');
    assert.equal(analyzeResult.quality.needsReview, false);

    const finalPrompt = String(requests.at(-1)?.messages?.[0]?.content ?? requests.at(-1)?.input?.[0]?.content ?? '');
    assert.match(finalPrompt, /"summary_chunks":\s*\[/);
    assert.match(finalPrompt, /重点更新/);
  } finally {
    await fixture.cleanup();
  }
});
