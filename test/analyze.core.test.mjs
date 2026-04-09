import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterNoiseTweets,
  resolveAnalyzeTimeoutMs,
  assessBriefQuality,
  injectQualityBanner,
  buildTweetEvidenceBlock,
  compactTweetText,
  parseCandidateScreeningResponse,
  mergeCandidateScreeningDecisions,
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

test('assessBriefQuality degrades low-coverage digests when all summary chunks fail', () => {
  const degraded = assessBriefQuality({
    coverage: { totalAccountCount: 125, coveredAccountCount: 25, incompleteAccountCount: 0, failedAccountCount: 0 },
    tweetCount: 116,
    signalTweetCount: 107,
    summaryChunkCount: 6,
    summaryFailedChunkCount: 6,
  });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.needsReview, true);
  assert.match(degraded.note, /limited sample/i);
  assert.match(degraded.note, /summary/i);
});

test('assessBriefQuality keeps live-like briefs healthy when dormant and no-tweet accounts are already resolved', () => {
  const quality = assessBriefQuality({
    coverage: {
      totalAccountCount: 125,
      coveredAccountCount: 28,
      noTweetAccountCount: 23,
      dormantAccountCount: 73,
      incompleteAccountCount: 1,
      failedAccountCount: 0,
    },
    tweetCount: 127,
    signalTweetCount: 119,
    summaryChunkCount: 5,
    summaryFailedChunkCount: 0,
  });
  assert.equal(quality.status, 'ok');
  assert.equal(quality.needsReview, false);
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
  assert.match(block, /"no_tweet_handles": \[/);
  assert.match(block, /"bob"/);
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

test('selectDigestEvidenceItems deprioritizes promotional tweets in heuristic fallback', () => {
  const items = [
    {
      tweetId: 'promo-1',
      username: 'marketer',
      createdAt: '2026-03-23T09:05:00Z',
      text: '🔥 9 HOURS LEFT: join now for my AI agent system, 1000+ workflows, private guide, daily coaching, demo vault, model stack, lifetime deal, $57K bonuses, upgrade today https://example.com/buy-now',
    },
    {
      tweetId: 'tech-1',
      username: 'builder',
      createdAt: '2026-03-23T09:00:00Z',
      text: 'OpenClaw MCP server shipped a reusable messaging layer with docs, benchmark notes, and GitHub examples https://github.com/example/openclaw-mcp',
    },
  ];

  const selected = selectDigestEvidenceItems(items, {
    maxTotalItems: 1,
    maxItemsPerAccount: 1,
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].tweetId, 'tech-1');
});

test('selectDigestEvidenceItems drops strategy-session and premium-bundle promos when enough technical tweets exist', () => {
  const items = [
    {
      tweetId: 'promo-julian',
      username: 'JulianGoldieSEO',
      createdAt: '2026-03-31T04:32:34Z',
      text: 'Free SEO Strategy Session Before Everyone Else Finds It. Digital entrepreneurs grab this free SEO strategy session today https://example.com/seo-session',
    },
    {
      tweetId: 'promo-bundle',
      username: 'rryssf_',
      createdAt: '2026-03-31T03:10:00Z',
      text: 'Your premium AI bundle to 10x your business. Prompts for marketing, unlimited custom prompts, weekly automations https://example.com/premium-bundle',
    },
    {
      tweetId: 'tech-1',
      username: 'builder-1',
      createdAt: '2026-03-31T02:00:00Z',
      text: 'Released an open source agent evaluation toolkit with benchmark docs and GitHub examples https://github.com/example/evals',
    },
    {
      tweetId: 'tech-2',
      username: 'builder-2',
      createdAt: '2026-03-31T01:30:00Z',
      text: 'Paper notes on reliable memory systems plus a runnable demo and dataset links https://example.com/research-memory',
    },
    {
      tweetId: 'tech-3',
      username: 'builder-3',
      createdAt: '2026-03-31T01:00:00Z',
      text: 'New tracing guide for Codex workflows with concrete implementation steps https://example.com/tracing-guide',
    },
  ];

  const selected = selectDigestEvidenceItems(items, {
    maxTotalItems: 3,
    maxItemsPerAccount: 1,
  });

  assert.equal(selected.length, 3);
  assert.deepEqual(new Set(selected.map((item) => item.tweetId)), new Set(['tech-1', 'tech-2', 'tech-3']));
});

test('selectDigestEvidenceItems prefers returning fewer items over refilling strong promos', () => {
  const items = [
    {
      tweetId: 'promo-1',
      username: 'marketer',
      createdAt: '2026-03-31T04:32:34Z',
      text: 'Free SEO Strategy Session Before Everyone Else Finds It. Digital entrepreneurs grab this free SEO strategy session today https://example.com/seo-session',
    },
    {
      tweetId: 'tech-1',
      username: 'builder-1',
      createdAt: '2026-03-31T02:00:00Z',
      text: 'Released an open source agent evaluation toolkit with benchmark docs and GitHub examples https://github.com/example/evals',
    },
    {
      tweetId: 'tech-2',
      username: 'builder-2',
      createdAt: '2026-03-31T01:30:00Z',
      text: 'Paper notes on reliable memory systems plus a runnable demo and dataset links https://example.com/research-memory',
    },
  ];

  const selected = selectDigestEvidenceItems(items, {
    maxTotalItems: 3,
    maxItemsPerAccount: 1,
  });

  assert.equal(selected.length, 2);
  assert.deepEqual(new Set(selected.map((item) => item.tweetId)), new Set(['tech-1', 'tech-2']));
});

test('selectDigestEvidenceItems drops urgency promos with hours, seats, and offers', () => {
  const items = [
    {
      tweetId: 'promo-urgency',
      username: 'JulianGoldieSEO',
      createdAt: '2026-03-31T04:23:35Z',
      text: '3HRS. 1 SEAT. YOU MISSED TWO OFFERS THIS WEEK. THIS IS THE LAST CALL https://example.com/offer',
    },
    {
      tweetId: 'tech-1',
      username: 'builder-1',
      createdAt: '2026-03-31T02:00:00Z',
      text: 'Released an open source agent evaluation toolkit with benchmark docs and GitHub examples https://github.com/example/evals',
    },
    {
      tweetId: 'tech-2',
      username: 'builder-2',
      createdAt: '2026-03-31T01:30:00Z',
      text: 'Paper notes on reliable memory systems plus a runnable demo and dataset links https://example.com/research-memory',
    },
  ];

  const selected = selectDigestEvidenceItems(items, {
    maxTotalItems: 3,
    maxItemsPerAccount: 1,
  });

  assert.equal(selected.length, 2);
  assert.deepEqual(new Set(selected.map((item) => item.tweetId)), new Set(['tech-1', 'tech-2']));
});

test('selectDigestEvidenceItems drops unicode-styled urgency promos after heuristic normalization', () => {
  const items = [
    {
      tweetId: 'promo-unicode-urgency',
      username: 'JulianGoldieSEO',
      createdAt: '2026-03-31T04:23:35Z',
      text: '🚨 𝟯𝗛𝗥𝗦. 𝟭 𝗦𝗘𝗔𝗧. 𝗬𝗢𝗨 𝗠𝗜𝗦𝗦𝗘𝗗 𝗧𝗪𝗢 𝗢𝗙𝗙𝗘𝗥𝗦 𝗧𝗛𝗜𝗦 𝗪𝗘𝗘𝗞. 𝗧𝗛𝗜𝗦 𝗜𝗦 𝗧𝗛𝗘 𝗟𝗔𝗦𝗧 𝗢𝗡𝗘.',
    },
    {
      tweetId: 'tech-1',
      username: 'builder-1',
      createdAt: '2026-03-31T02:00:00Z',
      text: 'Released an open source agent evaluation toolkit with benchmark docs and GitHub examples https://github.com/example/evals',
    },
    {
      tweetId: 'tech-2',
      username: 'builder-2',
      createdAt: '2026-03-31T01:30:00Z',
      text: 'Paper notes on reliable memory systems plus a runnable demo and dataset links https://example.com/research-memory',
    },
  ];

  const selected = selectDigestEvidenceItems(items, {
    maxTotalItems: 3,
    maxItemsPerAccount: 1,
  });

  assert.equal(selected.length, 2);
  assert.deepEqual(new Set(selected.map((item) => item.tweetId)), new Set(['tech-1', 'tech-2']));
});

test('parseCandidateScreeningResponse extracts structured candidates from JSON output', () => {
  const parsed = parseCandidateScreeningResponse([
    '```json',
    '[',
    '  {"tweet_id":"190001","handle":"alice","priority":3,"reason":"工具发布，信息密度高"},',
    '  {"tweet_id":"190002","handle":"bob","priority":2,"reason":"方法论总结"}',
    ']',
    '```',
  ].join('\n'));

  assert.deepEqual(parsed, [
    {
      tweetId: '190001',
      handle: 'alice',
      priority: 3,
      reason: '工具发布，信息密度高',
    },
    {
      tweetId: '190002',
      handle: 'bob',
      priority: 2,
      reason: '方法论总结',
    },
  ]);
});

test('mergeCandidateScreeningDecisions dedupes by tweet and applies per-account caps', () => {
  const signalItems = [
    { tweetId: '1', username: 'alice', createdAt: '2026-03-23T09:00:00Z', text: 'Release notes with benchmark results and GitHub link https://github.com/example/repo' },
    { tweetId: '2', username: 'alice', createdAt: '2026-03-23T08:00:00Z', text: 'Another launch update with docs https://example.com/docs' },
    { tweetId: '3', username: 'alice', createdAt: '2026-03-23T07:00:00Z', text: 'Third alice update with docs https://example.com/third' },
    { tweetId: '4', username: 'bob', createdAt: '2026-03-23T06:00:00Z', text: 'Paper summary with 3 concrete takeaways and demo link https://example.com/paper' },
    { tweetId: '5', username: 'carol', createdAt: '2026-03-23T05:00:00Z', text: 'Dataset release and benchmark notes https://example.com/dataset' },
  ];
  const decisions = [
    { tweetId: '1', handle: 'alice', priority: 3, reason: 'High-value release.' },
    { tweetId: '1', handle: 'alice', priority: 2, reason: 'Duplicate lower score.' },
    { tweetId: '2', handle: 'alice', priority: 2, reason: 'Useful docs.' },
    { tweetId: '3', handle: 'alice', priority: 1, reason: 'Should be capped out.' },
    { tweetId: '4', handle: 'bob', priority: 2, reason: 'Worth tracking.' },
    { tweetId: '5', handle: 'carol', priority: 0, reason: 'Should be filtered out.' },
  ];

  const merged = mergeCandidateScreeningDecisions(signalItems, decisions, {
    maxTotalItems: 3,
    maxItemsPerAccount: 2,
  });

  assert.equal(merged.length, 3);
  assert.equal(merged.filter((item) => item.username === 'alice').length, 2);
  assert.deepEqual(new Set(merged.map((item) => item.tweetId)), new Set(['1', '2', '4']));
});

test('mergeCandidateScreeningDecisions enforces a hard cap of 3 and a soft cap of 4 for priority-3 items', () => {
  const signalItems = [
    { tweetId: '1', username: 'alice', createdAt: '2026-03-23T09:00:00Z', text: 'Release 1 with docs https://example.com/1' },
    { tweetId: '2', username: 'alice', createdAt: '2026-03-23T08:00:00Z', text: 'Release 2 with docs https://example.com/2' },
    { tweetId: '3', username: 'alice', createdAt: '2026-03-23T07:00:00Z', text: 'Release 3 with docs https://example.com/3' },
    { tweetId: '4', username: 'alice', createdAt: '2026-03-23T06:00:00Z', text: 'Release 4 with docs https://example.com/4' },
    { tweetId: '5', username: 'alice', createdAt: '2026-03-23T05:00:00Z', text: 'Release 5 with docs https://example.com/5' },
    { tweetId: '6', username: 'alice', createdAt: '2026-03-23T04:00:00Z', text: 'Release 6 with docs https://example.com/6' },
  ];

  const mergedWithLowPriorityFourth = mergeCandidateScreeningDecisions(signalItems, [
    { tweetId: '1', handle: 'alice', priority: 3, reason: 'Top candidate.' },
    { tweetId: '2', handle: 'alice', priority: 2, reason: 'Second candidate.' },
    { tweetId: '3', handle: 'alice', priority: 2, reason: 'Third candidate.' },
    { tweetId: '4', handle: 'alice', priority: 2, reason: 'Should be blocked at hard cap.' },
  ], {
    maxTotalItems: 10,
  });
  assert.deepEqual(mergedWithLowPriorityFourth.map((item) => item.tweetId), ['1', '2', '3']);

  const mergedWithHighPriorityFourth = mergeCandidateScreeningDecisions(signalItems, [
    { tweetId: '1', handle: 'alice', priority: 3, reason: 'Top candidate.' },
    { tweetId: '2', handle: 'alice', priority: 2, reason: 'Second candidate.' },
    { tweetId: '3', handle: 'alice', priority: 2, reason: 'Third candidate.' },
    { tweetId: '4', handle: 'alice', priority: 3, reason: 'High-priority item under the hard cap.' },
    { tweetId: '5', handle: 'alice', priority: 3, reason: 'High-priority item under the hard cap.' },
    { tweetId: '6', handle: 'alice', priority: 3, reason: 'Allowed as the soft-cap exception.' },
  ], {
    maxTotalItems: 10,
  });
  assert.equal(mergedWithHighPriorityFourth.length, 4);
  assert.deepEqual(mergedWithHighPriorityFourth.map((item) => item.tweetId), ['1', '4', '5', '6']);
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
