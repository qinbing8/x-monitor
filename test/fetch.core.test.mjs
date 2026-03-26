import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRawResponse,
  renderTemplate,
  stripCodeFences,
  parseCsv,
  extractCsvPayload,
  parseTweetCsvResponse,
} from '../scripts/fetch.mjs';
import {
  FIXTURE_SEED_CSV,
  FIXTURE_HEADERLESS_FETCH_RESPONSE,
  FIXTURE_TWEET_FETCH_RESPONSE,
} from '../support/fixtures.mjs';

test('classifyRawResponse distinguishes valid, header-only, and narrative-only payloads', () => {
  assert.equal(classifyRawResponse('username,tweet_id,created_at,text,original_url\n', 0).classification, 'header_only');
  assert.equal(classifyRawResponse('No tweets were found for this account.', 0).classification, 'narrative_only');
  assert.equal(classifyRawResponse(FIXTURE_TWEET_FETCH_RESPONSE, 2).classification, 'valid');
  assert.equal(classifyRawResponse(FIXTURE_HEADERLESS_FETCH_RESPONSE, 2).classification, 'headerless_csv');
});

test('renderTemplate and stripCodeFences normalize prompt and fenced payload text', () => {
  assert.equal(renderTemplate('Hello {{NAME}}', { NAME: 'world' }), 'Hello world');
  assert.equal(stripCodeFences('```csv\nusername,tweet_id\n```'), 'username,tweet_id');
});

test('parseCsv handles BOM headers and parseTweetCsvResponse extracts fenced CSV', () => {
  const parsed = parseCsv(FIXTURE_SEED_CSV);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].Handle, 'alice');
  assert.equal(parsed[0].Bio, 'Builds tools, writes notes');

  const csvText = extractCsvPayload(FIXTURE_TWEET_FETCH_RESPONSE);
  assert.match(csvText, /^username,tweet_id,created_at,text,original_url/m);

  const response = parseTweetCsvResponse(FIXTURE_TWEET_FETCH_RESPONSE);
  assert.equal(response.records.length, 2);
});

test('parseTweetCsvResponse recovers headerless tweet CSV rows', () => {
  const response = parseTweetCsvResponse(FIXTURE_HEADERLESS_FETCH_RESPONSE);
  assert.equal(response.records.length, 2);
  assert.equal(response.parserDiagnostics.strategy, 'headerless_rows');
  assert.equal(response.records[0].tweet_id, '190015');
  assert.equal(response.records[1].original_url, 'https://x.com/alice/status/190016');
});
