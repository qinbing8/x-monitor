import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, main } from '../scripts/run.mjs';

test('parseArgs supports mode, analysis-profile, analyze-input, seed-csv, batch-size and skip-precheck overrides', () => {
  const parsed = parseArgs([
    '--mode', 'analyze',
    '--analysis-profile', 'claude-default',
    '--analyze-input', '.\\data\\run-1\\analyze.input.json',
    '--date', '2026-03-23',
    '--seed-csv', '.\\seed.csv',
    '--batch-size', '8',
    '--skip-precheck',
  ]);
  assert.equal(parsed.mode, 'analyze');
  assert.equal(parsed.analysisProfile, 'claude-default');
  assert.equal(parsed.analyzeInputPath, '.\\data\\run-1\\analyze.input.json');
  assert.equal(parsed.date, '2026-03-23');
  assert.equal(parsed.seedCsvPath, '.\\seed.csv');
  assert.equal(parsed.batchSize, 8);
  assert.equal(parsed.skipPrecheck, true);
});

test('main orchestrates fetch and analyze modes via injected dependencies', async () => {
  const calls = [];
  const prepareDailyRosterImpl = async (options) => {
    calls.push(['roster', options]);
    return { dailyCount: 2 };
  };
  const runFetchImpl = async (options) => {
    calls.push(['fetch', options]);
    return { tweetCount: 2 };
  };
  const runAnalyzeImpl = async (options) => {
    calls.push(['analyze', options]);
    return { analysisProfile: 'gpt-default' };
  };

  const fetchOnly = await main(['--mode', 'fetch', '--date', '2026-03-23'], { prepareDailyRosterImpl, runFetchImpl, runAnalyzeImpl });
  assert.deepEqual(fetchOnly, { mode: 'fetch', roster: { dailyCount: 2 }, fetch: { tweetCount: 2 } });

  const analyzeOnly = await main(
    ['--mode', 'analyze', '--analysis-profile', 'claude-default', '--analyze-input', '.\\data\\run-1\\analyze.input.json'],
    { prepareDailyRosterImpl, runFetchImpl, runAnalyzeImpl },
  );
  assert.deepEqual(analyzeOnly, { mode: 'analyze', analyze: { analysisProfile: 'gpt-default' } });
  assert.equal(calls[2][1].analyzeInputPath, '.\\data\\run-1\\analyze.input.json');
  assert.deepEqual(calls.map(([step]) => step), ['roster', 'fetch', 'analyze']);

  const fullRun = await main(['--mode', 'run', '--date', '2026-03-24'], { prepareDailyRosterImpl, runFetchImpl, runAnalyzeImpl });
  assert.equal(fullRun.mode, 'run');
  assert.equal(calls.length, 6);
});

test('main skips daily roster preparation when seed CSV is explicitly overridden', async () => {
  let prepared = false;
  const summary = await main(
    ['--mode', 'fetch', '--seed-csv', '.\\custom.csv'],
    {
      prepareDailyRosterImpl: async () => {
        prepared = true;
        return null;
      },
      runFetchImpl: async () => ({ tweetCount: 1 }),
      runAnalyzeImpl: async () => ({ analysisProfile: 'gpt-default' }),
    },
  );

  assert.equal(prepared, false);
  assert.deepEqual(summary, { mode: 'fetch', fetch: { tweetCount: 1 } });
});

test('main rejects analyze-input outside analyze mode', async () => {
  await assert.rejects(
    main(['--mode', 'run', '--analyze-input', '.\\data\\run-1\\analyze.input.json']),
    /--analyze-input is only supported in analyze mode/,
  );
});

test('main rejects combining analyze-input with an explicit date override', async () => {
  await assert.rejects(
    main(['--mode', 'analyze', '--analyze-input', '.\\data\\run-1\\analyze.input.json', '--date', '2026-03-24']),
    /--date cannot be combined with --analyze-input/,
  );
});

test('main rejects unsupported modes', async () => {
  await assert.rejects(
    main(['--mode', 'unknown']),
    /Unsupported mode: unknown/,
  );
});
