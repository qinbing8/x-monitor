import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('default Grok fetch profile does not skip dormant accounts before fetching', () => {
  const config = JSON.parse(readFileSync('config.example.json', 'utf8'));
  const precheck = config.fetch?.profiles?.['grok-default']?.precheck;

  assert.equal(precheck?.enabled, false);
  assert.equal(precheck?.staticFilterZeroPosts, false);
});
