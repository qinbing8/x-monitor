export async function withRetry(task, retry = {}, options = {}) {
  const maxAttempts = Math.max(1, Number(retry.maxAttempts ?? 1));
  const backoffMs = Math.max(0, Number(retry.backoffMs ?? 0));
  const logger = options.logger;
  const operationName = options.operationName ?? 'request';
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const retryDelayMs = backoffMs * attempt;
      logger?.warn('retry_attempt_failed', {
        operationName,
        attempt,
        maxAttempts,
        retryDelayMs,
        error: error?.message ?? String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  logger?.error('retry_exhausted', {
    operationName,
    maxAttempts,
    error: lastError?.message ?? String(lastError),
  });
  throw lastError;
}

export async function postChatCompletions({ baseUrl, apiKey, model, messages, timeoutMs, temperature, maxTokens, fetchImpl = fetch, logger, operationName = 'chat_completion' }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const startMs = Date.now();
  logger?.debug('llm_request_start', {
    operationName,
    model,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    timeoutMs,
    maxTokens,
  });
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startMs;
    const httpStatus = response.status;
    if (!response.ok) {
      const bodyText = await response.text();
      throw Object.assign(
        new Error(`HTTP ${httpStatus}: ${bodyText}`),
        { httpStatus, latencyMs },
      );
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? '';
    const text = Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content);
    const finishReason = json?.choices?.[0]?.finish_reason ?? null;
    const usage = json?.usage ?? null;
    const result = {
      json,
      text,
      diagnostics: {
        httpStatus,
        latencyMs,
        responseBytes: JSON.stringify(json).length,
        finishReason,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        truncated: finishReason === 'length',
      },
    };
    logger?.info('llm_request_complete', {
      operationName,
      model,
      httpStatus,
      latencyMs,
      finishReason,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
    });
    return result;
  } catch (error) {
    logger?.error('llm_request_failed', {
      operationName,
      model,
      httpStatus: error?.httpStatus ?? null,
      latencyMs: error?.latencyMs ?? (Date.now() - startMs),
      error: error?.message ?? String(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
