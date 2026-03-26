import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv,
  normalizeSeedAccounts,
  parseTweetCsvResponse,
  normalizeTweetRecords,
  summarizeBatchCoverage,
} from '../scripts/fetch.mjs';
import {
  FIXTURE_SEED_CSV,
  FIXTURE_TWEET_FETCH_RESPONSE,
} from '../support/fixtures.mjs';

test('normalizeSeedAccounts maps CSV seed rows into normalized account records', () => {
  const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
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

test('normalizeTweetRecords and summarizeBatchCoverage tolerate fenced CSV output', () => {
  const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
  const { records } = parseTweetCsvResponse(FIXTURE_TWEET_FETCH_RESPONSE);

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
