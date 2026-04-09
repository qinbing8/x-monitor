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
  const html = renderMarkdownDocument(FIXTURE_ANALYZE_MARKDOWN, {
    title: '日报页面',
  });

  assert.match(html, /<title>日报页面<\/title>/);
  assert.match(html, /<h1 id="x-日报-2026-03-23">X 日报 \| 2026-03-23<\/h1>/);
  assert.match(html, /<h2 id="今日要点摘要deep-brief">今日要点摘要（Deep Brief）<\/h2>/);
  assert.match(html, /<code>@alice<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.com\/alice\/status\/190001">https:\/\/x\.com\/alice\/status\/190001<\/a>/);
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

  await writeFile(finalReportPath, FIXTURE_ANALYZE_MARKDOWN, 'utf8');
  await writeFile(
    analyzeResultPath,
    JSON.stringify({
      meta: {
        analyzedAt: '2026-03-23T08:10:00.000Z',
      },
      quality: {
        needsReview: false,
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

  assert.equal(published.runDate, '2026-03-23');
  assert.equal(published.runId, 'run-080000-abcdef12');
  assert.match(finalHtml, /<h1 id="x-日报-2026-03-23">X 日报 \| 2026-03-23<\/h1>/);
  assert.equal(latestJson.runId, 'run-080000-abcdef12');
  assert.equal(latestJson.reportUrl, 'https://report.example.com/reports/2026-03-23/run-080000-abcdef12');
  assert.equal(indexJson.length, 1);
  assert.equal(indexJson[0].markdownKey, 'reports/2026-03-23/run-080000-abcdef12/final.md');
  assert.equal(copiedFetchResult.meta.fetchedAt, '2026-03-23T08:01:00.000Z');
});
