function responseWithHeaders(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      'cache-control': 'public, max-age=300',
      ...(init.headers ?? {}),
    },
  });
}

async function readJson(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return object.json();
}

async function readText(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return {
    text: await object.text(),
    contentType: object.httpMetadata?.contentType ?? 'text/plain; charset=utf-8',
  };
}

function renderHistoryPage(entries = []) {
  const items = (Array.isArray(entries) ? entries : [])
    .map((entry) => `
      <li>
        <a href="${entry?.reportUrl ?? '#'}">${entry?.title ?? '未命名日报'}</a>
        <p>${entry?.summary ?? ''}</p>
        <small>${entry?.updatedAt ?? ''}</small>
      </li>
    `)
    .join('');

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>x-monitor 历史日报</title>',
    '  <style>',
    '    body { margin: 0; background: #f5f2e8; color: #1f1c18; font-family: "Noto Serif SC", Georgia, serif; }',
    '    main { max-width: 880px; margin: 0 auto; padding: 40px 24px 72px; }',
    '    ul { list-style: none; padding: 0; }',
    '    li { background: #fffdf7; border: 1px solid #e1d6c5; border-radius: 14px; padding: 18px 20px; margin-bottom: 16px; }',
    '    a { color: #0b5cad; font-size: 1.15rem; text-decoration: none; }',
    '    p { margin: 10px 0; line-height: 1.7; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>x-monitor 历史日报</h1>',
    '    <ul>',
    items,
    '    </ul>',
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function buildReportKey(date, runId, fileName) {
  return `reports/${date}/${runId}/${fileName}`;
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const bucket = env?.REPORT_BUCKET;
  if (!bucket) {
    return responseWithHeaders('REPORT_BUCKET binding is missing', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (url.pathname === '/') {
    const latest = await readJson(bucket, 'reports/latest.json');
    if (!latest?.reportKey) {
      return responseWithHeaders('Latest report not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const report = await readText(bucket, latest.reportKey);
    if (!report) {
      return responseWithHeaders('Latest report file not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return responseWithHeaders(report.text, {
      headers: { 'content-type': report.contentType },
    });
  }

  if (url.pathname === '/history') {
    const index = await readJson(bucket, 'reports/index.json');
    return responseWithHeaders(renderHistoryPage(index), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  if (url.pathname === '/raw/latest') {
    const latest = await readJson(bucket, 'reports/latest.json');
    if (!latest?.markdownKey) {
      return responseWithHeaders('Latest raw report not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const report = await readText(bucket, latest.markdownKey);
    if (!report) {
      return responseWithHeaders('Latest raw report file not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return responseWithHeaders(report.text, {
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    });
  }

  const reportMatch = url.pathname.match(/^\/reports\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/);
  if (reportMatch) {
    const report = await readText(bucket, buildReportKey(reportMatch[1], reportMatch[2], 'final.html'));
    if (!report) {
      return responseWithHeaders('Report not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return responseWithHeaders(report.text, {
      headers: { 'content-type': report.contentType },
    });
  }

  const rawMatch = url.pathname.match(/^\/raw\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/);
  if (rawMatch) {
    const report = await readText(bucket, buildReportKey(rawMatch[1], rawMatch[2], 'final.md'));
    if (!report) {
      return responseWithHeaders('Raw report not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return responseWithHeaders(report.text, {
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    });
  }

  return responseWithHeaders('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
