import assert from 'node:assert/strict';

import { runFetch } from '../scripts/fetch.mjs';
import { runAnalyze } from '../scripts/analyze.mjs';
import {
  FIXTURE_ANALYZE_MARKDOWN,
  FIXTURE_TWEET_FETCH_RESPONSE,
  createCompletionFetch,
  createMockSkillFixture,
  readJson,
  readText,
} from './test-fixtures.mjs';

const fixture = await createMockSkillFixture();

try {
  const fetchSummary = await runFetch({
    configPath: fixture.configPath,
    date: '2026-03-23',
    fetchImpl: createCompletionFetch(FIXTURE_TWEET_FETCH_RESPONSE),
  });

  const fetchInput = await readJson(fetchSummary.fetchInputPath);
  const fetchRaw = await readJson(fetchSummary.fetchRawPath);
  const fetchRawCsv = await readText(fetchSummary.fetchRawCsvPath);
  const fetchResult = await readJson(fetchSummary.fetchResultPath);

  assert.equal(fetchInput.seeds.length, 2);
  assert.equal(fetchRaw.batches.length, 1);
  assert.match(fetchRawCsv, /tweet_id/);
  assert.equal(fetchResult.items.length, 2);
  assert.equal(fetchResult.accounts[0].status, 'covered');
  assert.equal(fetchResult.accounts[1].status, 'no_tweets_found');

  console.log('fetch smoke ok');
  console.log(`  fetchInputPath: ${fetchSummary.fetchInputPath}`);
  console.log(`  fetchRawPath: ${fetchSummary.fetchRawPath}`);
  console.log(`  fetchRawCsvPath: ${fetchSummary.fetchRawCsvPath}`);
  console.log(`  fetchResultPath: ${fetchSummary.fetchResultPath}`);
  console.log(`  tweetCount: ${fetchSummary.tweetCount}`);

  const analyzeSummary = await runAnalyze({
    configPath: fixture.configPath,
    date: '2026-03-23',
    fetchImpl: createCompletionFetch(FIXTURE_ANALYZE_MARKDOWN),
  });

  const analyzeInput = await readJson(analyzeSummary.analyzeInputPath);
  const analyzeResult = await readJson(analyzeSummary.analyzeResultPath);
  const finalReport = await readText(analyzeSummary.finalReportPath);

  assert.equal(analyzeInput.evidence.items.length, 2);
  assert.equal(analyzeInput.evidence.accounts[1].status, 'no_tweets_found');
  assert.equal(analyzeResult.answer.markdown, FIXTURE_ANALYZE_MARKDOWN);
  assert.equal(finalReport, FIXTURE_ANALYZE_MARKDOWN);

  console.log('analyze smoke ok');
  console.log(`  analyzeInputPath: ${analyzeSummary.analyzeInputPath}`);
  console.log(`  analyzeResultPath: ${analyzeSummary.analyzeResultPath}`);
  console.log(`  finalReportPath: ${analyzeSummary.finalReportPath}`);

  console.log('\nsmoke validation passed');
} finally {
  await fixture.cleanup();
}
