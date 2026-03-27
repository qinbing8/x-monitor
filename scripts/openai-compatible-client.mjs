function summarizeErrorCause(error) {
  if (!error) return null;
  if (typeof error !== 'object' && typeof error !== 'function') {
    return {
      name: null,
      message: String(error),
      code: null,
      errno: null,
      type: typeof error,
    };
  }
  const code = error.code;
  const errno = error.errno;
  return {
    name: typeof error.name === 'string' ? error.name : null,
    message: typeof error.message === 'string' ? error.message : String(error),
    code: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
    errno: Number.isFinite(errno) ? errno : null,
    type: typeof error.type === 'string' ? error.type : null,
  };
}

function collectErrorCauseChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error?.cause;
  while (current && chain.length < 6) {
    if (typeof current === 'object' || typeof current === 'function') {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(summarizeErrorCause(current));
    current = current?.cause;
  }
  return chain;
}

function resolveRequestTarget(baseUrl) {
  try {
    const targetUrl = new URL(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`);
    return {
      targetHost: targetUrl.host,
      targetPath: targetUrl.pathname,
    };
  } catch {
    return {
      targetHost: null,
      targetPath: null,
    };
  }
}

function classifyLlmRequestError(error, errorCode) {
  const message = String(error?.message ?? '');
  if (/Request timed out after \d+ms/i.test(message)) return 'timeout';
  if (typeof error?.httpStatus === 'number' || message.startsWith('HTTP ')) return 'http_error';
  if (error?.name === 'AbortError') return 'abort';
  if (/fetch failed/i.test(message)) return 'network_error';
  if (typeof errorCode === 'string' && /^(ECONN|EHOST|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR)/i.test(errorCode)) {
    return 'network_error';
  }
  return 'unknown';
}

function buildLlmRequestFailureDiagnostics(error, context = {}) {
  const causeChain = collectErrorCauseChain(error);
  const errorCode = [error?.code, ...causeChain.map((entry) => entry?.code).filter(Boolean)]
    .find((value) => value !== undefined && value !== null);
  const { targetHost, targetPath } = resolveRequestTarget(context.baseUrl);
  return {
    operationName: context.operationName ?? 'request',
    model: context.model ?? null,
    timeoutMs: Number.isFinite(context.timeoutMs) ? context.timeoutMs : null,
    maxTokens: Number.isFinite(context.maxTokens) ? context.maxTokens : null,
    messageCount: Number.isFinite(context.messageCount) ? context.messageCount : null,
    targetHost,
    targetPath,
    classification: classifyLlmRequestError(error, errorCode ? String(errorCode) : null),
    errorName: typeof error?.name === 'string' ? error.name : null,
    errorMessage: typeof error?.message === 'string' ? error.message : String(error),
    errorCode: errorCode ? String(errorCode) : null,
    httpStatus: Number.isFinite(context.httpStatus) ? context.httpStatus : null,
    latencyMs: Number.isFinite(context.latencyMs) ? context.latencyMs : null,
    causeChain,
  };
}

function extractCompletionText(content) {
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
  if (content === undefined || content === null) return '';
  return String(content);
}

function extractChoiceText(choice) {
  const deltaContent = choice?.delta?.content;
  if (deltaContent !== undefined) return extractCompletionText(deltaContent);
  return extractCompletionText(choice?.message?.content ?? choice?.text ?? '');
}

function takeNextSseEvent(buffer) {
  const match = buffer.match(/^([\s\S]*?)(\r?\n\r?\n)/);
  if (!match) return null;
  return { rawEvent: match[1], rest: buffer.slice(match[0].length) };
}

function parseSseEventData(rawEvent) {
  const dataLines = String(rawEvent ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

async function readChatCompletionStream(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Streaming response body is not readable');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = null;
  let usage = null;
  let responseBytes = 0;
  const consumeEvent = (rawEvent) => {
    const data = parseSseEventData(rawEvent);
    if (!data) return false;
    if (data === '[DONE]') return true;
    const chunk = JSON.parse(data);
    const choice = chunk?.choices?.[0];
    text += extractChoiceText(choice);
    finishReason = choice?.finish_reason ?? finishReason;
    usage = chunk?.usage ?? usage;
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    responseBytes += value?.byteLength ?? 0;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const nextEvent = takeNextSseEvent(buffer);
      if (!nextEvent) break;
      buffer = nextEvent.rest;
      if (consumeEvent(nextEvent.rawEvent)) return { text, finishReason, usage, responseBytes };
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer.trim());
  return { text, finishReason, usage, responseBytes };
}

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
      try {
        error.retryDiagnostics = {
          operationName,
          attempt,
          maxAttempts,
          retryDelayMs: attempt >= maxAttempts ? 0 : backoffMs * attempt,
          exhausted: attempt >= maxAttempts,
          backoffMs,
        };
      } catch {
        // Ignore non-extensible error objects.
      }
      if (attempt >= maxAttempts) break;
      const retryDelayMs = backoffMs * attempt;
      logger?.warn('retry_attempt_failed', {
        operationName,
        attempt,
        maxAttempts,
        retryDelayMs,
        error: error?.message ?? String(error),
        errorClassification: error?.llmRequestDiagnostics?.classification ?? null,
        httpStatus: error?.llmRequestDiagnostics?.httpStatus ?? null,
        errorCode: error?.llmRequestDiagnostics?.errorCode ?? null,
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  logger?.error('retry_exhausted', {
    operationName,
    maxAttempts,
    error: lastError?.message ?? String(lastError),
    errorClassification: lastError?.llmRequestDiagnostics?.classification ?? null,
    httpStatus: lastError?.llmRequestDiagnostics?.httpStatus ?? null,
    errorCode: lastError?.llmRequestDiagnostics?.errorCode ?? null,
  });
  throw lastError;
}

export async function postChatCompletions({ baseUrl, apiKey, model, messages, timeoutMs, temperature, maxTokens, stream = false, fetchImpl = fetch, logger, operationName = 'chat_completion' }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const startMs = Date.now();
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  logger?.debug('llm_request_start', {
    operationName,
    model,
    messageCount,
    timeoutMs,
    maxTokens,
    stream,
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
        stream,
      }),
      signal: controller.signal,
    });
    const httpStatus = response.status;
    if (!response.ok) {
      const latencyMs = Date.now() - startMs;
      const bodyText = await response.text();
      throw Object.assign(
        new Error(`HTTP ${httpStatus}: ${bodyText}`),
        { httpStatus, latencyMs },
      );
    }
    const payload = stream
      ? await readChatCompletionStream(response)
      : (() => {
        const jsonPromise = response.json();
        return jsonPromise.then((json) => ({
          json,
          text: extractChoiceText(json?.choices?.[0]),
          finishReason: json?.choices?.[0]?.finish_reason ?? null,
          usage: json?.usage ?? null,
          responseBytes: JSON.stringify(json).length,
        }));
      })();
    const { json = null, text, finishReason, usage, responseBytes } = await payload;
    const latencyMs = Date.now() - startMs;
    const completion = {
      json,
      text,
      diagnostics: {
        httpStatus,
        latencyMs,
        responseBytes,
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
      stream,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
    });
    return completion;
  } catch (error) {
    const diagnostics = buildLlmRequestFailureDiagnostics(error, {
      operationName,
      model,
      baseUrl,
      timeoutMs,
      maxTokens,
      messageCount,
      httpStatus: error?.httpStatus ?? null,
      latencyMs: error?.latencyMs ?? (Date.now() - startMs),
    });
    try {
      error.llmRequestDiagnostics = diagnostics;
    } catch {
      // Ignore non-extensible error objects.
    }
    logger?.error('llm_request_failed', diagnostics);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
