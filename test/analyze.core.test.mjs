import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterNoiseTweets,
  resolveAnalyzeTimeoutMs,
  assessBriefQuality,
  injectQualityBanner,
  buildTweetEvidenceBlock,
  compactTweetText,
  selectDigestEvidenceItems,
} from '../scripts/analyze.mjs';

test('resolveAnalyzeTimeoutMs enforces a live-safe timeout floor', () => {
  assert.equal(resolveAnalyzeTimeoutMs(90000), 300000);
  assert.equal(resolveAnalyzeTimeoutMs(180000), 300000);
  assert.equal(resolveAnalyzeTimeoutMs(240000), 300000);
  assert.equal(resolveAnalyzeTimeoutMs(360000), 360000);
  assert.equal(resolveAnalyzeTimeoutMs(undefined), 300000);
});

test('filterNoiseTweets separates low-signal placeholders from real tweets', () => {
  const { signal, noise } = filterNoiseTweets([
    { text: 'test placeholder' },
    { text: 'Shipped a detailed tracing CLI with benchmarks and docs.' },
  ]);
  assert.equal(signal.length, 1);
  assert.equal(noise.length, 1);
  assert.equal(noise[0].noiseReason, 'pattern_match');
});

test('assessBriefQuality marks empty and degraded coverage correctly', () => {
  const empty = assessBriefQuality({
    coverage: { totalAccountCount: 10, coveredAccountCount: 0, incompleteAccountCount: 0, failedAccountCount: 0 },
    tweetCount: 0,
    signalTweetCount: 0,
  });
  assert.equal(empty.status, 'empty');

  const degraded = assessBriefQuality({
    coverage: { totalAccountCount: 20, coveredAccountCount: 2, incompleteAccountCount: 1, failedAccountCount: 0 },
    tweetCount: 5,
    signalTweetCount: 2,
  });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.needsReview, true);
});

test('injectQualityBanner prefixes degraded markdown and leaves healthy markdown untouched', () => {
  const markdown = '# Report\n\nBody';
  const degraded = injectQualityBanner(markdown, { status: 'degraded', note: 'Partial evidence.' });
  assert.match(degraded, /^# Report/);
  assert.match(degraded, /Partial evidence/);
  assert.equal(injectQualityBanner(markdown, { status: 'ok' }), markdown);
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

test('selectDigestEvidenceItems caps prompt evidence by account and total count', () => {
  const items = [
    { tweetId: '1', username: 'alice', createdAt: '2026-03-23T09:00:00Z', text: 'Release notes with benchmark results and GitHub link https://github.com/example/repo' },
    { tweetId: '2', username: 'alice', createdAt: '2026-03-23T08:00:00Z', text: 'Another launch update with docs https://example.com/docs' },
    { tweetId: '3', username: 'alice', createdAt: '2026-03-23T07:00:00Z', text: 'Short chatter' },
    { tweetId: '4', username: 'bob', createdAt: '2026-03-23T06:00:00Z', text: 'Paper summary with 3 concrete takeaways and demo link https://example.com/paper' },
    { tweetId: '5', username: 'carol', createdAt: '2026-03-23T05:00:00Z', text: 'Dataset release and benchmark notes https://example.com/dataset' },
  ];

  const selected = selectDigestEvidenceItems(items, {
    maxTotalItems: 4,
    maxItemsPerAccount: 2,
  });

  assert.equal(selected.length, 4);
  assert.equal(selected.filter((item) => item.username === 'alice').length, 2);
});

test('compactTweetText and buildTweetEvidenceBlock keep prompt tweet text bounded', () => {
  const longText = 'A'.repeat(400);
  assert.equal(compactTweetText(longText, 20), `${'A'.repeat(19)}…`);

  const block = buildTweetEvidenceBlock({
    meta: { sourceProvider: 'grok', timeWindowHours: 24 },
    accounts: [
      { seedId: 'seed-1', handle: 'alice', displayName: 'Alice Maker', status: 'covered', tweetCount: 1, notes: [] },
    ],
    items: [
      {
        tweetId: '190099',
        username: 'alice',
        displayName: 'Alice Maker',
        createdAt: '2026-03-23T01:02:03Z',
        text: longText,
        originalUrl: 'https://x.com/alice/status/190099',
        batchId: 'batch-1',
        source: { seedId: 'seed-1' },
      },
    ],
    warnings: [],
    omittedSignalTweetCount: 3,
  });

  assert.match(block, /"omitted_signal_tweets": 3/);
  assert.doesNotMatch(block, /A{320}/);
});
