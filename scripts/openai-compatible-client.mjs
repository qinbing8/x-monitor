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

const OPENAI_RESPONSES_API = 'openai-responses';

function normalizeApiProtocol(apiProtocol) {
  return String(apiProtocol ?? '').trim().toLowerCase() === OPENAI_RESPONSES_API
    ? OPENAI_RESPONSES_API
    : 'openai-completions';
}

function resolveRequestUrl(baseUrl, apiProtocol) {
  const endpointPath = normalizeApiProtocol(apiProtocol) === OPENAI_RESPONSES_API
    ? '/responses'
    : '/chat/completions';
  return `${String(baseUrl).replace(/\/+$/, '')}${endpointPath}`;
}

function resolveRequestTarget(baseUrl, apiProtocol) {
  try {
    const targetUrl = new URL(resolveRequestUrl(baseUrl, apiProtocol));
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
  const { targetHost, targetPath } = resolveRequestTarget(context.baseUrl, context.apiProtocol);
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

function normalizeResponsesInputContent(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (!Array.isArray(content)) return String(content);
  return content.map((part) => {
    if (typeof part === 'string') return { type: 'input_text', text: part };
    if (!part || typeof part !== 'object') return { type: 'input_text', text: String(part ?? '') };
    if (part.type === 'input_text') return part;
    if (part.type === 'text' || part.type === 'output_text') {
      return { type: 'input_text', text: String(part.text ?? '') };
    }
    return part;
  });
}

function normalizeResponsesInput(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message?.role ?? 'user',
    content: normalizeResponsesInputContent(message?.content),
  }));
}

function extractResponsesOutputText(responseJson) {
  if (typeof responseJson?.output_text === 'string') return responseJson.output_text;
  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  return output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => (part?.type === 'output_text' || !part?.type) && typeof part?.text === 'string')
    .map((part) => part.text)
    .join('');
}

function resolveResponsesFinishReason(responseJson, fallbackStatus = null) {
  const status = String(responseJson?.status ?? fallbackStatus ?? '').trim().toLowerCase();
  const incompleteReason = String(responseJson?.incomplete_details?.reason ?? '').trim().toLowerCase();
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') return 'length';
    return incompleteReason || 'incomplete';
  }
  if (status === 'completed') return 'stop';
  return status || null;
}

function normalizeTokenUsage(usage = {}) {
  return {
    promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
  };
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

async function readResponsesStream(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Streaming response body is not readable');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = null;
  let usage = null;
  let json = null;
  let responseBytes = 0;

  const consumeEvent = (rawEvent) => {
    const data = parseSseEventData(rawEvent);
    if (!data) return false;
    if (data === '[DONE]') return true;
    const event = JSON.parse(data);
    const eventType = String(event?.type ?? '');
    if (eventType === 'error') {
      throw new Error(typeof event?.error?.message === 'string' ? event.error.message : 'Responses API stream error');
    }
    if (eventType === 'response.output_text.delta') {
      text += String(event?.delta ?? '');
      return false;
    }
    if (eventType === 'response.output_text.done') {
      if (!text && typeof event?.text === 'string') text = event.text;
      return false;
    }
    if (eventType === 'response.done' || eventType === 'response.completed' || eventType === 'response.incomplete' || eventType === 'response.failed') {
      json = event?.response ?? json;
      if (!text) text = extractResponsesOutputText(json);
      usage = json?.usage ?? usage;
      finishReason = resolveResponsesFinishReason(json, eventType.replace(/^response\./, ''));
      return true;
    }
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
      if (consumeEvent(nextEvent.rawEvent)) {
        return {
          json,
          text,
          finishReason,
          usage,
          responseBytes,
        };
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer.trim());
  return {
    json,
    text,
    finishReason,
    usage,
    responseBytes,
  };
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

function hasHeader(headers, headerName) {
  const expected = String(headerName ?? '').trim().toLowerCase();
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}

function buildRequestHeaders({ apiKey, extraHeaders, authHeader }) {
  const headers = {
    ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
    'Content-Type': 'application/json',
  };
  if (authHeader !== false && !hasHeader(headers, 'Authorization')) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export async function postChatCompletions({
  baseUrl,
  apiKey,
  apiProtocol,
  model,
  messages,
  timeoutMs,
  temperature,
  maxTokens,
  stream = false,
  extraHeaders,
  authHeader = true,
  fetchImpl = fetch,
  logger,
  operationName = 'chat_completion',
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const startMs = Date.now();
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  const resolvedApiProtocol = normalizeApiProtocol(apiProtocol);
  const requestUrl = resolveRequestUrl(baseUrl, resolvedApiProtocol);
  logger?.debug('llm_request_start', {
    operationName,
    model,
    apiProtocol: resolvedApiProtocol,
    messageCount,
    timeoutMs,
    maxTokens,
    stream,
  });
  try {
    const response = await fetchImpl(requestUrl, {
      method: 'POST',
      headers: buildRequestHeaders({ apiKey, extraHeaders, authHeader }),
      body: JSON.stringify(
        resolvedApiProtocol === OPENAI_RESPONSES_API
          ? {
            model,
            input: normalizeResponsesInput(messages),
            temperature,
            max_output_tokens: maxTokens,
            stream,
          }
          : {
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream,
          },
      ),
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
      ? await (resolvedApiProtocol === OPENAI_RESPONSES_API
        ? readResponsesStream(response)
        : readChatCompletionStream(response))
      : (() => {
        const jsonPromise = response.json();
        return jsonPromise.then((json) => ({
          json,
          text: resolvedApiProtocol === OPENAI_RESPONSES_API
            ? extractResponsesOutputText(json)
            : extractChoiceText(json?.choices?.[0]),
          finishReason: resolvedApiProtocol === OPENAI_RESPONSES_API
            ? resolveResponsesFinishReason(json)
            : json?.choices?.[0]?.finish_reason ?? null,
          usage: json?.usage ?? null,
          responseBytes: JSON.stringify(json).length,
        }));
      })();
    const { json = null, text, finishReason, usage, responseBytes } = await payload;
    const latencyMs = Date.now() - startMs;
    const tokenUsage = normalizeTokenUsage(usage);
    const completion = {
      json,
      text,
      diagnostics: {
        httpStatus,
        latencyMs,
        responseBytes,
        finishReason,
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
        truncated: finishReason === 'length',
      },
    };
    logger?.info('llm_request_complete', {
      operationName,
      model,
      apiProtocol: resolvedApiProtocol,
      httpStatus,
      latencyMs,
      finishReason,
      stream,
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
    });
    return completion;
  } catch (error) {
    const diagnostics = buildLlmRequestFailureDiagnostics(error, {
      operationName,
      model,
      baseUrl,
      apiProtocol: resolvedApiProtocol,
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
