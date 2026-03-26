import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { parseCsv, normalizeSeedAccounts, runActivityPrecheck } from '../scripts/fetch.mjs';
import {
  FIXTURE_PRECHECK_RESPONSE_ALL_ACTIVE,
  FIXTURE_PRECHECK_RESPONSE_DORMANT,
  FIXTURE_REFERENCE_TIME,
  FIXTURE_SEED_CSV,
  createCompletionFetch,
  createMockSkillFixture,
} from '../support/fixtures.mjs';

function buildPrecheckProfile() {
  return {
    provider: { baseUrl: 'https://grok.example/v1', apiKey: 'grok-key' },
    model: 'grok-4.1-fast',
    retry: { maxAttempts: 1, backoffMs: 50 },
  };
}

test('runActivityPrecheck filters dormant accounts and keeps active ones', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
    const precheckPromptPath = join(fixture.skillRoot, 'assets', 'prompts', 'grok-precheck.txt');
    const result = await runActivityPrecheck({
      seeds,
      profile: buildPrecheckProfile(),
      fetchImpl: createCompletionFetch(FIXTURE_PRECHECK_RESPONSE_DORMANT),
      referenceTime: FIXTURE_REFERENCE_TIME,
      precheckConfig: {
        enabled: true,
        dormantThresholdDays: 7,
        batchSize: 10,
        timeoutMs: 5000,
        maxOutputTokens: 500,
        promptFile: precheckPromptPath,
      },
    });

    assert.equal(result.activeSeeds.length, 1);
    assert.equal(result.activeSeeds[0].handle, 'alice');
    assert.equal(result.dormantSeeds.length, 1);
    assert.equal(result.dormantSeeds[0].handle, 'bob');
    assert.equal(result.dormantSeeds[0].status, 'dormant_skipped');
    assert.ok(result.dormantSeeds[0].daysSinceLastTweet > 7);
  } finally {
    await fixture.cleanup();
  }
});

test('runActivityPrecheck treats all accounts as active when all have recent tweets', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
    const precheckPromptPath = join(fixture.skillRoot, 'assets', 'prompts', 'grok-precheck.txt');
    const result = await runActivityPrecheck({
      seeds,
      profile: buildPrecheckProfile(),
      fetchImpl: createCompletionFetch(FIXTURE_PRECHECK_RESPONSE_ALL_ACTIVE),
      referenceTime: FIXTURE_REFERENCE_TIME,
      precheckConfig: {
        enabled: true,
        dormantThresholdDays: 7,
        batchSize: 10,
        timeoutMs: 5000,
        maxOutputTokens: 500,
        promptFile: precheckPromptPath,
      },
    });

    assert.equal(result.activeSeeds.length, 2);
    assert.equal(result.dormantSeeds.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('runActivityPrecheck fails open and treats accounts as active on parse failure', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const seeds = normalizeSeedAccounts(parseCsv(FIXTURE_SEED_CSV));
    const precheckPromptPath = join(fixture.skillRoot, 'assets', 'prompts', 'grok-precheck.txt');
    const result = await runActivityPrecheck({
      seeds,
      profile: buildPrecheckProfile(),
      fetchImpl: createCompletionFetch('Sorry, I cannot process this request.'),
      referenceTime: FIXTURE_REFERENCE_TIME,
      precheckConfig: {
        enabled: true,
        dormantThresholdDays: 7,
        batchSize: 10,
        timeoutMs: 5000,
        maxOutputTokens: 500,
        promptFile: precheckPromptPath,
      },
    });

    assert.equal(result.activeSeeds.length, 2);
    assert.equal(result.dormantSeeds.length, 0);
  } finally {
    await fixture.cleanup();
  }
});
