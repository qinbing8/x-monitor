import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFetch, parseCsv } from '../scripts/fetch.mjs';
import { runAnalyze } from '../scripts/analyze.mjs';

const RUN_LIVE = process.env.X_MONITOR_RUN_LIVE === '1';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const LIVE_TIMEOUT_MS = 45 * 60 * 1000;

function normalizeHandle(value, fallbackUrl = '') {
  const text = String(value ?? '').trim().replace(/^@/, '');
  if (text) return text;
  const match = String(fallbackUrl ?? '').trim().match(/x\.com\/([^/?#]+)/i);
  return match?.[1] ?? '';
}

function toIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid live acceptance date: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeLiveDiagnostic(payload) {
  const logDir = fileURLToPath(new URL('../data/live-acceptance', import.meta.url));
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(logDir, `${stamp}-attempt-${payload.attempt}.json`);
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

async function runLiveAcceptanceAttempt({ configPath, runDate, referenceTime, attempt }) {
  const seedCsvPath = process.env.X_MONITOR_LIVE_SEED_CSV
    ? (isAbsolute(process.env.X_MONITOR_LIVE_SEED_CSV)
      ? process.env.X_MONITOR_LIVE_SEED_CSV
      : resolve(fileURLToPath(new URL('..', import.meta.url)), process.env.X_MONITOR_LIVE_SEED_CSV))
    : fileURLToPath(new URL('../X列表关注者.daily.csv', import.meta.url));
  const seedRecords = parseCsv(await readFile(seedCsvPath, 'utf8'));
  const requestedHandles = new Set(
    seedRecords
      .map((record) => normalizeHandle(record.Handle, record.UserPageURL))
      .filter(Boolean)
      .map((handle) => handle.toLowerCase()),
  );

  const fetchSummary = await runFetch({
    configPath,
    date: runDate,
    seedCsvPath,
    referenceTime,
  });
  const fetchResult = await readJson(fetchSummary.fetchResultPath);
  const tweetIndexRows = parseCsv(await readFile(fetchSummary.fetchTweetIndexCsvPath, 'utf8'));

  assert.equal(fetchResult.meta.sourceProvider, 'grok');
  assert.equal(fetchResult.meta.sourceCsvPath, seedCsvPath);
  assert.equal(fetchResult.meta.windowEndUtc, referenceTime);
  assert.ok(fetchSummary.durationMs < FIFTEEN_MINUTES_MS, `Fetch took ${fetchSummary.durationMs}ms, expected < ${FIFTEEN_MINUTES_MS}ms`);
  assert.ok(fetchResult.items.length > 0, 'Grok did not return any in-window tweet items for the daily roster');
  assert.equal(tweetIndexRows.length, fetchResult.items.length);

  const windowStartMs = Date.parse(fetchResult.meta.windowStartUtc);
  const windowEndMs = Date.parse(fetchResult.meta.windowEndUtc);
  for (const item of fetchResult.items) {
    assert.ok(requestedHandles.has(String(item.username ?? '').toLowerCase()), `Fetched handle @${item.username} is not in the requested daily roster`);
    const createdAtMs = Date.parse(item.createdAt);
    assert.ok(Number.isFinite(createdAtMs), `Fetched tweet ${item.tweetId} has an invalid createdAt`);
    assert.ok(createdAtMs >= windowStartMs, `Fetched tweet ${item.tweetId} is older than the 24h window`);
    assert.ok(createdAtMs <= windowEndMs, `Fetched tweet ${item.tweetId} is newer than the acceptance reference time`);
  }

  const analyzeSummary = await runAnalyze({
    configPath,
    date: runDate,
  });
  const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
  const markdown = String(analyzeResult.answer?.markdown ?? '').trim();

  assert.equal(analyzeResult.meta.provider, 'gpt');
  assert.equal(analyzeResult.answer?.source, 'model', `GPT did not generate the daily brief. Fetch diagnosis: ${analyzeResult.meta.fetchDiagnosis?.note ?? 'unknown'}`);
  assert.ok(markdown.length > 0, 'GPT daily brief is empty');

  return {
    attempt,
    runDate,
    referenceTime,
    seedCsvPath,
    dailyCount: requestedHandles.size,
    fetch: {
      runDir: fetchSummary.runDir,
      durationMs: fetchSummary.durationMs,
      tweetCount: fetchResult.items.length,
      coveredAccountCount: fetchResult.meta.coveredAccountCount,
      incompleteAccountCount: fetchResult.meta.incompleteAccountCount,
      failedAccountCount: fetchResult.meta.failedAccountCount,
      warningCount: fetchResult.warnings.length,
    },
    analyze: {
      runDir: analyzeSummary.runDir,
      answerSource: analyzeResult.answer?.source,
      markdownLength: markdown.length,
      fetchDiagnosis: analyzeResult.meta.fetchDiagnosis,
      quality: analyzeResult.quality,
    },
  };
}

test('live acceptance: Grok fetches the daily roster within 24h and GPT produces a readable daily brief', { timeout: LIVE_TIMEOUT_MS }, async (t) => {
  if (!RUN_LIVE) {
    t.skip('Set X_MONITOR_RUN_LIVE=1 to run the real API acceptance test.');
    return;
  }

  const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
  const now = new Date();
  const referenceTime = process.env.X_MONITOR_LIVE_REFERENCE_TIME ?? now.toISOString();
  const runDate = process.env.X_MONITOR_LIVE_DATE ?? toIsoDate(referenceTime);
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await runLiveAcceptanceAttempt({
        configPath,
        runDate,
        referenceTime,
        attempt,
      });
      await writeLiveDiagnostic({
        status: 'passed',
        ...result,
      });
      return;
    } catch (error) {
      lastError = error;
      await writeLiveDiagnostic({
        status: 'failed',
        attempt,
        runDate,
        referenceTime,
        error: error?.stack ?? String(error),
      });
    }
  }

  throw lastError;
});
