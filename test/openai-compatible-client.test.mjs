import test from 'node:test';
import assert from 'node:assert/strict';

import { withRetry, postChatCompletions } from '../scripts/openai-compatible-client.mjs';
import { createCompletionResponse } from '../support/fixtures.mjs';

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

test('withRetry honors retryAfterMs from upstream rate limits', async () => {
  const originalSetTimeout = global.setTimeout;
  const scheduledDelays = [];
  global.setTimeout = ((handler, delay, ...args) => {
    scheduledDelays.push(delay);
    return originalSetTimeout(handler, 0, ...args);
  });

  let attempts = 0;
  try {
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 2) {
        const error = new Error('HTTP 429: rate limit');
        error.retryAfterMs = 12000;
        throw error;
      }
      return 'ok';
    }, { maxAttempts: 2, backoffMs: 1500 });

    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
    assert.deepEqual(scheduledDelays, [12000]);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
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

test('postChatCompletions routes openai-responses requests to /responses and extracts output text', async () => {
  let requestUrl = null;
  let requestBody = null;
  const completion = await postChatCompletions({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    apiProtocol: 'openai-responses',
    model: 'gpt-test',
    reasoningEffort: 'xhigh',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 5000,
    temperature: 0,
    maxTokens: 32,
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: 'response',
          status: 'completed',
          output_text: 'world',
          output: [{
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'world', annotations: [] }],
          }],
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
      };
    },
  });

  assert.equal(requestUrl, 'https://example.com/v1/responses');
  assert.deepEqual(requestBody.input, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(requestBody.reasoning, { effort: 'xhigh' });
  assert.equal(requestBody.max_output_tokens, 32);
  assert.equal(completion.text, 'world');
  assert.equal(completion.diagnostics.finishReason, 'stop');
  assert.equal(completion.diagnostics.promptTokens, 12);
  assert.equal(completion.diagnostics.completionTokens, 7);
});

test('postChatCompletions appends /v1 for origin-only openai-compatible base URLs', async () => {
  let requestUrl = null;
  await postChatCompletions({
    baseUrl: 'https://api.x.ai',
    apiKey: 'test-key',
    model: 'grok-test',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 5000,
    temperature: 0,
    maxTokens: 32,
    fetchImpl: async (url) => {
      requestUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'world' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
      };
    },
  });

  assert.equal(requestUrl, 'https://api.x.ai/v1/chat/completions');
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

test('postChatCompletions can consume streaming chat completion responses', async () => {
  let requestedStream = null;
  const completion = await postChatCompletions({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 5000,
    temperature: 0,
    maxTokens: 32,
    stream: true,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requestedStream = body.stream;
      return createCompletionResponse({
        content: 'world',
        finishReason: 'stop',
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      }, body);
    },
  });

  assert.equal(requestedStream, true);
  assert.equal(completion.text, 'world');
  assert.equal(completion.diagnostics.finishReason, 'stop');
  assert.equal(completion.diagnostics.promptTokens, 9);
  assert.equal(completion.diagnostics.completionTokens, 4);
});

test('postChatCompletions can consume streaming responses API responses', async () => {
  let requestUrl = null;
  let requestedStream = null;
  const completion = await postChatCompletions({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    apiProtocol: 'openai-responses',
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 5000,
    temperature: 0,
    maxTokens: 32,
    stream: true,
    fetchImpl: async (url, options) => {
      requestUrl = url;
      const body = JSON.parse(options.body);
      requestedStream = body.stream;
      return createCompletionResponse({
        content: 'world',
        finishReason: 'stop',
        usage: { input_tokens: 9, output_tokens: 4 },
      }, body);
    },
  });

  assert.equal(requestUrl, 'https://example.com/v1/responses');
  assert.equal(requestedStream, true);
  assert.equal(completion.text, 'world');
  assert.equal(completion.diagnostics.finishReason, 'stop');
  assert.equal(completion.diagnostics.promptTokens, 9);
  assert.equal(completion.diagnostics.completionTokens, 4);
});

test('postChatCompletions forwards provider headers and can disable Authorization header', async () => {
  let requestHeaders = null;
  await postChatCompletions({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    apiProtocol: 'openai-responses',
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 5000,
    temperature: 0,
    maxTokens: 32,
    extraHeaders: {
      'User-Agent': 'curl/8.0',
      'X-Test-Header': '1',
    },
    authHeader: false,
    fetchImpl: async (_url, options) => {
      requestHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: 'response',
          status: 'completed',
          output_text: 'world',
          output: [{
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'world', annotations: [] }],
          }],
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
      };
    },
  });

  assert.equal(requestHeaders['User-Agent'], 'curl/8.0');
  assert.equal(requestHeaders['X-Test-Header'], '1');
  assert.equal('Authorization' in requestHeaders, false);
});
