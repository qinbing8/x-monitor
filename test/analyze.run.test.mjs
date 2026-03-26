import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
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
  createMockSkillFixture,
  readJson,
  readText,
} from '../support/fixtures.mjs';

test('repo analysis profiles keep timeout above the known live-run failure threshold', async () => {
  const repoConfig = await readJson(fileURLToPath(new URL('../config.json', import.meta.url)));
  const exampleConfig = await readJson(fileURLToPath(new URL('../config.example.json', import.meta.url)));

  for (const [label, config] of [['config.json', repoConfig], ['config.example.json', exampleConfig]]) {
    assert.ok(config.analysis.profiles['gpt-default'].timeoutMs > 90000, `${label} gpt-default timeoutMs must stay above 90000ms`);
    assert.ok(config.analysis.profiles['claude-default'].timeoutMs > 90000, `${label} claude-default timeoutMs must stay above 90000ms`);
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
    assert.equal(analyzeResult.meta.model, 'gpt-5.4(xhigh)');
    assert.equal(analyzeResult.meta.tweetCount, 2);
    assert.equal(analyzeResult.meta.coverage.failedAccountCount, 0);
    assert.equal(analyzeResult.meta.fetchDiagnosis.status, 'ready');
    assert.equal(analyzeResult.answer.source, 'model');
    assert.equal(analyzeResult.answer.markdown, FIXTURE_ANALYZE_MARKDOWN);
    assert.equal(analyzeResult.quality.needsReview, false);

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

    const scoreState = await readJson(join(fixture.skillRoot, 'account-score.json'));
    const alice = scoreState.accounts.find((entry) => entry.handle === 'alice');
    assert.equal(alice.score, 4);
    assert.equal(alice.tier, 'daily');
  } finally {
    await fixture.cleanup();
  }
});

test('runAnalyze writes a readable fallback diagnosis when the GPT brief is empty', async () => {
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
    assert.match(analyzeResult.answer.markdown, /GPT 未返回可用日报正文/);

    const finalReport = await readText(analyzeSummary.finalReportPath);
    assert.match(finalReport, /抓取诊断/);
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
