import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  renderMarkdownDocument,
  mergeIndexEntries,
  publishRunArtifacts,
} from '../scripts/publish-report.mjs';
import {
  FIXTURE_ANALYZE_MARKDOWN,
} from '../support/fixtures.mjs';

test('renderMarkdownDocument converts report markdown into readable HTML', () => {
  const markdown = [
    '# X 日报 | 2026-03-23',
    '',
    '## 今日亮点',
    '- Alice 发布新的 agent tracing CLI。',
    '',
    '## 高价值推文',
    '- Alice 发布新的 agent tracing CLI https://x.com/alice/status/190001 | 浏览 12000 · 点赞 340 · 回复 18',
    '- Bob 发布 benchmark notes https://x.com/bob/status/190002 | 浏览 48000 · 点赞 820 · 回复 64',
  ].join('\n');
  const html = renderMarkdownDocument(markdown, {
    title: '日报页面',
  });

  assert.match(html, /<title>日报页面<\/title>/);
  assert.match(html, /<h1 id="x-日报-2026-03-23">X 日报 \| 2026-03-23<\/h1>/);
  assert.match(html, /<h2 id="今日亮点">今日亮点<\/h2>/);
  assert.doesNotMatch(html, /今日要点摘要/);
  assert.doesNotMatch(html, /<code>@alice<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.com\/alice\/status\/190001" class="source-link">查看原文<\/a>/);
  assert.doesNotMatch(html, /<a href="https:\/\/x\.com\/alice\/status\/190001">https:\/\/x\.com\/alice\/status\/190001<\/a>/);
  assert.equal((html.match(/class="source-link">查看原文/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<li>\s*<\/li>/);
  assert.match(html, /<main class="report-shell">/);
  assert.match(html, /<article class="report-document">/);
  assert.match(html, /font-family: "Inter", "PingFang SC"/);
  assert.match(html, /@page \{ size: A4; margin: 20mm 22mm 22mm; \}/);
});

test('renderMarkdownDocument converts bold inline markdown', () => {
  const html = renderMarkdownDocument('- **Gemma 4** 是今天最明确的模型发布信号。');

  assert.match(html, /<strong>Gemma 4<\/strong> 是今天最明确的模型发布信号。/);
  assert.doesNotMatch(html, /\*\*Gemma 4\*\*/);
});

test('renderMarkdownDocument keeps tweet link policy when paragraphs flush before lists', () => {
  const html = renderMarkdownDocument([
    '# X 日报',
    '',
    '## 今日亮点',
    '- 摘要段落 https://x.com/alice/status/190101',
    '',
    '## 高价值推文',
    '- 高价值段落 https://x.com/bob/status/190102 | 浏览 100 · 点赞 2 · 回复 1',
  ].join('\n'));

  assert.doesNotMatch(html, /https:\/\/x\.com\/alice\/status\/190101/);
  assert.match(html, /<a href="https:\/\/x\.com\/bob\/status\/190102" class="source-link">查看原文<\/a>/);
  assert.doesNotMatch(html, /<a href="https:\/\/x\.com\/bob\/status\/190102">https:\/\/x\.com\/bob\/status\/190102<\/a>/);
});

test('mergeIndexEntries keeps newest entry first and deduplicates by date and runId', () => {
  const older = {
    date: '2026-03-23',
    runId: 'run-old',
    title: '旧日报',
    summary: '旧摘要',
    reportKey: 'reports/2026-03-23/run-old/final.html',
    markdownKey: 'reports/2026-03-23/run-old/final.md',
    updatedAt: '2026-03-23T01:00:00.000Z',
  };
  const newer = {
    ...older,
    summary: '新摘要',
    updatedAt: '2026-03-23T02:00:00.000Z',
  };

  const merged = mergeIndexEntries([older], newer, 10);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].summary, '新摘要');
});

test('publishRunArtifacts extracts index summary from 今日亮点', async () => {
  const root = await mkdtemp(join(tmpdir(), 'x-monitor-publish-summary-'));
  const runDir = resolve(root, 'data', '2026-06-11', 'run-080000-abcdef12');
  const outputDir = resolve(root, '.tmp', 'published');
  const summaryPath = resolve(root, '.tmp', 'run-summary.json');
  const previousIndexPath = resolve(root, '.tmp', 'previous-index.json');

  await mkdir(runDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(runDir, 'final.md'), [
    '# X 日报 | 2026-06-11',
    '',
    '> Low-coverage digest: partial evidence.',
    '',
    '## 今日亮点',
    '- OpenAI 确认封号为系统 Bug，赔偿一个月订阅。',
    '',
    '## 高价值推文',
    '- OpenAI 确认封号为系统 Bug https://x.com/openai/status/190001 | 浏览 931 · 点赞 13 · 回复 9',
  ].join('\n'), 'utf8');
  await writeFile(resolve(runDir, 'analyze.result.json'), JSON.stringify({
    meta: { analyzedAt: '2026-06-11T08:10:00.000Z' },
    quality: { needsReview: true, status: 'degraded', note: 'partial evidence' },
  }, null, 2), 'utf8');
  await writeFile(summaryPath, JSON.stringify({
    mode: 'run',
    analyze: {
      runDir,
      finalReportPath: resolve(runDir, 'final.md'),
      analyzeResultPath: resolve(runDir, 'analyze.result.json'),
    },
  }, null, 2), 'utf8');
  await writeFile(previousIndexPath, '[]', 'utf8');

  await publishRunArtifacts({
    summaryPath,
    outputDir,
    previousIndexPath,
    siteOrigin: 'https://example.com',
    publicBaseUrl: 'https://example.com/reports',
  });

  const indexJson = JSON.parse(await readFile(resolve(outputDir, 'reports', 'index.json'), 'utf8'));
  assert.equal(indexJson[0].summary, 'OpenAI 确认封号为系统 Bug，赔偿一个月订阅。');
});

test('publishRunArtifacts writes publishable files and latest/index metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'x-monitor-publish-'));
  const runDir = resolve(root, 'data', '2026-03-23', 'run-080000-abcdef12');
  const fetchRunDir = resolve(root, 'data', '2026-03-23', 'run-075900-ffffeeee');
  const outputDir = resolve(root, '.tmp', 'published');

  await mkdir(runDir, { recursive: true });
  await mkdir(fetchRunDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const finalReportPath = resolve(runDir, 'final.md');
  const analyzeResultPath = resolve(runDir, 'analyze.result.json');
  const fetchResultPath = resolve(fetchRunDir, 'fetch.result.json');
  const summaryPath = resolve(root, '.tmp', 'run-summary.json');
  const previousIndexPath = resolve(root, '.tmp', 'previous-index.json');

  await writeFile(
    finalReportPath,
    [
      '# X 日报 | 2026-03-23',
      '',
      '> Low-coverage digest: 1 incomplete account. Treat this brief as partial evidence.',
      '',
      FIXTURE_ANALYZE_MARKDOWN.replace(/^# X 日报 \| 2026-03-23\n\n/, ''),
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    analyzeResultPath,
    JSON.stringify({
      meta: {
        analyzedAt: '2026-03-23T08:10:00.000Z',
      },
      quality: {
        needsReview: true,
        status: 'degraded',
        note: 'Low-coverage digest: 1 incomplete account.',
      },
    }, null, 2),
    'utf8',
  );
  await writeFile(
    fetchResultPath,
    JSON.stringify({
      meta: {
        fetchedAt: '2026-03-23T08:01:00.000Z',
      },
      items: [],
    }, null, 2),
    'utf8',
  );
  await writeFile(previousIndexPath, JSON.stringify([], null, 2), 'utf8');
  await writeFile(
    summaryPath,
    JSON.stringify({
      mode: 'run',
      fetch: {
        runDir: fetchRunDir,
        fetchResultPath,
      },
      analyze: {
        runDir,
        analyzeResultPath,
        finalReportPath,
      },
    }, null, 2),
    'utf8',
  );

  const published = await publishRunArtifacts({
    summaryPath,
    outputDir,
    previousIndexPath,
    siteOrigin: 'https://report.example.com',
    publishedAt: '2026-03-23T08:12:00.000Z',
  });

  const publishedDir = resolve(outputDir, 'reports', '2026-03-23', 'run-080000-abcdef12');
  const finalHtml = await readFile(resolve(publishedDir, 'final.html'), 'utf8');
  const latestJson = JSON.parse(await readFile(resolve(outputDir, 'reports', 'latest.json'), 'utf8'));
  const indexJson = JSON.parse(await readFile(resolve(outputDir, 'reports', 'index.json'), 'utf8'));
  const copiedFetchResult = JSON.parse(await readFile(resolve(publishedDir, 'fetch.result.json'), 'utf8'));
  const publicMarkdown = await readFile(resolve(publishedDir, 'final.md'), 'utf8');
  const maintenanceJson = JSON.parse(await readFile(resolve(publishedDir, 'maintenance.json'), 'utf8'));

  assert.equal(published.runDate, '2026-03-23');
  assert.equal(published.runId, 'run-080000-abcdef12');
  assert.match(finalHtml, /<h1 id="x-日报-2026-03-23">X 日报 \| 2026-03-23<\/h1>/);
  assert.doesNotMatch(finalHtml, /抓取覆盖与缺口|覆盖与风险|质量门控|Low-coverage digest/);
  assert.doesNotMatch(publicMarkdown, /抓取覆盖与缺口|覆盖与风险|质量门控|Low-coverage digest/);
  assert.equal(latestJson.runId, 'run-080000-abcdef12');
  assert.equal(latestJson.reportUrl, 'https://report.example.com/reports/2026-03-23/run-080000-abcdef12');
  assert.equal(latestJson.maintenanceUrl, 'https://report.example.com/maintenance/2026-03-23/run-080000-abcdef12');
  assert.equal(indexJson.length, 1);
  assert.equal(indexJson[0].markdownKey, 'reports/2026-03-23/run-080000-abcdef12/final.md');
  assert.equal(copiedFetchResult.meta.fetchedAt, '2026-03-23T08:01:00.000Z');
  assert.equal(maintenanceJson.run.date, '2026-03-23');
  assert.equal(maintenanceJson.artifacts.analyzeResultKey, 'reports/2026-03-23/run-080000-abcdef12/analyze.result.json');
  assert.equal(maintenanceJson.quality.needsReview, true);
  assert.match(maintenanceJson.quality.note, /Low-coverage digest/);
});

test('publishRunArtifacts keeps model availability notices visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'x-monitor-publish-model-issue-'));
  const runDir = resolve(root, 'data', '2026-03-23', 'run-080000-abcdef12');
  const outputDir = resolve(root, '.tmp', 'published');
  const summaryPath = resolve(root, '.tmp', 'run-summary.json');
  const previousIndexPath = resolve(root, '.tmp', 'previous-index.json');

  await mkdir(runDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(runDir, 'final.md'), [
    '# X 日报 | 2026-03-23',
    '',
    '> 终稿模型请求失败：401 Invalid API key，请检查模型可用性。以下内容基于已完成的抓取、筛选与摘要结果自动整理。',
    '',
    '## 今日亮点',
    '- Alice Maker 的推文 [查看原文](https://x.com/alice/status/190001)',
  ].join('\n'), 'utf8');
  await writeFile(resolve(runDir, 'analyze.result.json'), JSON.stringify({
    meta: {
      analyzedAt: '2026-03-23T08:10:00.000Z',
      modelAvailabilityIssue: '401 Invalid API key，请检查模型可用性',
    },
    answer: {
      source: 'fallback',
      generatedBy: 'structured_fallback',
    },
    quality: {
      needsReview: true,
      status: 'degraded',
      note: 'Final draft model auth failed.',
    },
  }, null, 2), 'utf8');
  await writeFile(summaryPath, JSON.stringify({
    mode: 'run',
    analyze: {
      runDir,
      analyzeResultPath: resolve(runDir, 'analyze.result.json'),
      finalReportPath: resolve(runDir, 'final.md'),
    },
  }, null, 2), 'utf8');
  await writeFile(previousIndexPath, '[]', 'utf8');

  await publishRunArtifacts({
    summaryPath,
    outputDir,
    previousIndexPath,
  });

  const publishedDir = resolve(outputDir, 'reports', '2026-03-23', 'run-080000-abcdef12');
  const finalHtml = await readFile(resolve(publishedDir, 'final.html'), 'utf8');
  const publicMarkdown = await readFile(resolve(publishedDir, 'final.md'), 'utf8');
  const maintenanceJson = JSON.parse(await readFile(resolve(publishedDir, 'maintenance.json'), 'utf8'));

  assert.match(finalHtml, /401 Invalid API key，请检查模型可用性/);
  assert.match(publicMarkdown, /401 Invalid API key，请检查模型可用性/);
  assert.equal(maintenanceJson.pipeline.modelAvailabilityIssue, '401 Invalid API key，请检查模型可用性');
});
