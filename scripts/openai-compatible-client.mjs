export async function withRetry(task, retry = {}) {
  const maxAttempts = Math.max(1, Number(retry.maxAttempts ?? 1));
  const backoffMs = Math.max(0, Number(retry.backoffMs ?? 0));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw lastError;
}

export async function postChatCompletions({ baseUrl, apiKey, model, messages, timeoutMs, temperature, maxTokens, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const startMs = Date.now();
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
    return {
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
  } finally {
    clearTimeout(timeout);
  }
}
