import test from 'node:test';
import assert from 'node:assert/strict';

import workerModule, { handleRequest } from '../worker/src/index.js';

function createMockObject(body, contentType = 'text/plain; charset=utf-8') {
  return {
    httpMetadata: {
      contentType,
    },
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  };
}

function createMockEnv(entries) {
  return {
    REPORT_BUCKET: {
      async get(key) {
        const value = entries[key];
        if (!value) return null;
        if (typeof value === 'string') return createMockObject(value, key.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json');
        return value;
      },
    },
  };
}

test('handleRequest serves the latest HTML report at root path', async () => {
  const env = createMockEnv({
    'reports/latest.json': JSON.stringify({
      reportKey: 'reports/2026-03-23/run-080000-abcdef12/final.html',
    }),
    'reports/2026-03-23/run-080000-abcdef12/final.html': '<html><body>latest report</body></html>',
  });

  const response = await handleRequest(new Request('https://report.example.com/'), env);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /latest report/);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('handleRequest renders history page from index.json', async () => {
  const env = createMockEnv({
    'reports/index.json': JSON.stringify([
      {
        date: '2026-03-23',
        runId: 'run-080000-abcdef12',
        title: 'X 日报 | 2026-03-23',
        summary: '当天摘要',
        reportUrl: 'https://report.example.com/reports/2026-03-23/run-080000-abcdef12',
      },
    ]),
  });

  const response = await handleRequest(new Request('https://report.example.com/history'), env);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /当天摘要/);
  assert.match(html, /2026-03-23/);
});

test('default export delegates fetch requests to handleRequest', async () => {
  const env = createMockEnv({
    'reports/latest.json': JSON.stringify({
      reportKey: 'reports/2026-03-23/run-080000-abcdef12/final.html',
    }),
    'reports/2026-03-23/run-080000-abcdef12/final.html': '<html><body>delegated report</body></html>',
  });

  const response = await workerModule.fetch(new Request('https://report.example.com/'), env);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /delegated report/);
});
