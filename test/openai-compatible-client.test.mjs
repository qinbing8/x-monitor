import test from 'node:test';
import assert from 'node:assert/strict';

import { withRetry, postChatCompletions } from '../scripts/openai-compatible-client.mjs';

test('withRetry retries until the task succeeds', async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts += 1;
    if (attempts < 2) throw new Error('transient');
    return 'ok';
  }, { maxAttempts: 3, backoffMs: 0 });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('withRetry throws the last error after exhausting attempts', async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(async () => {
      attempts += 1;
      throw new Error(`fail-${attempts}`);
    }, { maxAttempts: 2, backoffMs: 0 }),
    /fail-2/,
  );
  assert.equal(attempts, 2);
});

test('postChatCompletions returns text and diagnostics from successful responses', async () => {
  const completion = await postChatCompletions({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 5000,
    temperature: 0,
    maxTokens: 32,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }),
    }),
  });

  assert.equal(completion.text, 'world');
  assert.equal(completion.diagnostics.httpStatus, 200);
  assert.equal(completion.diagnostics.finishReason, 'stop');
  assert.equal(completion.diagnostics.promptTokens, 12);
  assert.equal(completion.diagnostics.completionTokens, 7);
});

test('postChatCompletions surfaces HTTP failures with status metadata', async () => {
  await assert.rejects(
    postChatCompletions({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 5000,
      temperature: 0,
      maxTokens: 32,
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        text: async () => 'rate limit',
      }),
    }),
    /HTTP 429: rate limit/,
  );
});
