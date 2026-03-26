import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, main } from '../scripts/run.mjs';

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

  const analyzeOnly = await main(['--mode', 'analyze', '--analysis-profile', 'claude-default'], { prepareDailyRosterImpl, runFetchImpl, runAnalyzeImpl });
  assert.deepEqual(analyzeOnly, { mode: 'analyze', analyze: { analysisProfile: 'gpt-default' } });

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

test('main rejects unsupported modes', async () => {
  await assert.rejects(
    main(['--mode', 'unknown']),
    /Unsupported mode: unknown/,
  );
});
