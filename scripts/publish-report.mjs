#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugifyHeading(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function renderInlineMarkdown(text) {
  const codeTokens = [];
  const linkTokens = [];
  let rendered = String(text ?? '')
    .replace(/`([^`]+)`/g, (_, code) => {
      const token = `@@CODE${codeTokens.length}@@`;
      codeTokens.push(`<code>${escapeHtml(code)}</code>`);
      return token;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) => {
      const token = `@@LINK${linkTokens.length}@@`;
      linkTokens.push(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
      return token;
    });

  rendered = escapeHtml(rendered).replace(
    /(https?:\/\/[^\s<]+)/g,
    (match) => `<a href="${match}">${match}</a>`,
  );

  rendered = rendered
    .replace(/@@CODE(\d+)@@/g, (_, index) => codeTokens[Number(index)] ?? '')
    .replace(/@@LINK(\d+)@@/g, (_, index) => linkTokens[Number(index)] ?? '');

  return rendered;
}

function flushParagraph(paragraphLines, output) {
  if (paragraphLines.length === 0) return;
  output.push(`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
  paragraphLines.length = 0;
}

function closeListIfNeeded(state, output) {
  if (!state.inList) return;
  output.push('</ul>');
  state.inList = false;
}

export function renderMarkdownDocument(markdown, options = {}) {
  const lines = String(markdown ?? '').replace(/\r/g, '').split('\n');
  const body = [];
  const paragraphLines = [];
  const listState = { inList: false };
  let inCodeBlock = false;
  let codeLines = [];

  const flushCodeBlock = () => {
    if (codeLines.length === 0) return;
    body.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushParagraph(paragraphLines, body);
      closeListIfNeeded(listState, body);
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph(paragraphLines, body);
      closeListIfNeeded(listState, body);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph(paragraphLines, body);
      closeListIfNeeded(listState, body);
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      body.push(`<h${level} id="${slugifyHeading(text)}">${renderInlineMarkdown(text)}</h${level}>`);
      continue;
    }

    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch) {
      flushParagraph(paragraphLines, body);
      if (!listState.inList) {
        body.push('<ul>');
        listState.inList = true;
      }
      body.push(`<li>${renderInlineMarkdown(listMatch[1].trim())}</li>`);
      continue;
    }

    closeListIfNeeded(listState, body);
    paragraphLines.push(trimmed);
  }

  if (inCodeBlock) flushCodeBlock();
  flushParagraph(paragraphLines, body);
  closeListIfNeeded(listState, body);

  const title = options.title ? String(options.title) : 'x-monitor report';
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    '    :root { color-scheme: light; }',
    '    body { margin: 0; background: #f5f2e8; color: #1f1c18; font-family: "Noto Serif SC", "Source Han Serif SC", Georgia, serif; }',
    '    main { max-width: 880px; margin: 0 auto; padding: 40px 24px 72px; }',
    '    h1, h2, h3 { line-height: 1.25; color: #15110d; }',
    '    h1 { font-size: 2.2rem; margin: 0 0 1.5rem; }',
    '    h2 { margin-top: 2.4rem; border-top: 1px solid #d9cfbf; padding-top: 1.2rem; }',
    '    p, li { font-size: 1.02rem; line-height: 1.8; }',
    '    ul { padding-left: 1.4rem; }',
    '    code { background: #efe7d8; padding: 0.1rem 0.35rem; border-radius: 4px; font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace; }',
    '    pre { overflow-x: auto; background: #201b16; color: #f6efe5; padding: 16px; border-radius: 10px; }',
    '    a { color: #0b5cad; text-decoration: none; }',
    '    a:hover { text-decoration: underline; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    body.map((chunk) => `    ${chunk}`).join('\n'),
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function extractTitle(markdown, fallback) {
  const lines = String(markdown ?? '').replace(/\r/g, '').split('\n');
  const firstHeading = lines.find((line) => /^#\s+/.test(line.trim()));
  if (!firstHeading) return fallback;
  return firstHeading.replace(/^#\s+/, '').trim();
}

function stripInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSummary(markdown) {
  const lines = String(markdown ?? '').replace(/\r/g, '').split('\n');
  let inDeepBrief = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+今日要点摘要/.test(trimmed)) {
      inDeepBrief = true;
      continue;
    }
    if (inDeepBrief && /^##\s+/.test(trimmed)) break;
    if (inDeepBrief && /^-\s+/.test(trimmed)) {
      return stripInlineMarkdown(trimmed.replace(/^-\s+/, '')).slice(0, 120);
    }
  }
  const fallbackLine = lines
    .map((line) => line.trim())
    .find((line) => line && !/^#+\s+/.test(line) && !/^-\s*$/.test(line));
  return stripInlineMarkdown(fallbackLine ?? '').slice(0, 120);
}

export function mergeIndexEntries(previousEntries, nextEntry, limit = 30) {
  const entries = Array.isArray(previousEntries) ? previousEntries : [];
  const filtered = entries.filter((entry) => !(entry?.date === nextEntry.date && entry?.runId === nextEntry.runId));
  return [nextEntry, ...filtered]
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    .slice(0, limit);
}

async function readJsonIfExists(filePath, fallbackValue) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function buildReportLinks(runDate, runId, siteOrigin = '') {
  const normalizedOrigin = String(siteOrigin ?? '').trim().replace(/\/+$/, '');
  const reportPath = `/reports/${runDate}/${runId}`;
  const rawPath = `/raw/${runDate}/${runId}`;
  return {
    reportUrl: normalizedOrigin ? `${normalizedOrigin}${reportPath}` : reportPath,
    rawUrl: normalizedOrigin ? `${normalizedOrigin}${rawPath}` : rawPath,
  };
}

export async function publishRunArtifacts({
  summaryPath,
  outputDir,
  previousIndexPath,
  siteOrigin,
  publishedAt,
} = {}) {
  if (!summaryPath) throw new Error('summaryPath is required');
  if (!outputDir) throw new Error('outputDir is required');

  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const analyzeRunDir = String(summary?.analyze?.runDir ?? '').trim();
  const finalReportPath = String(summary?.analyze?.finalReportPath ?? '').trim();
  const analyzeResultPath = String(summary?.analyze?.analyzeResultPath ?? '').trim();
  const fetchResultPath = String(summary?.fetch?.fetchResultPath ?? '').trim();

  if (!analyzeRunDir || !finalReportPath || !analyzeResultPath) {
    throw new Error('Run summary is missing analyze output paths');
  }

  const runId = basename(analyzeRunDir);
  const runDate = basename(dirname(analyzeRunDir));
  const outputRoot = resolve(outputDir, 'reports');
  const publishedRunDir = resolve(outputRoot, runDate, runId);
  await mkdir(publishedRunDir, { recursive: true });

  const finalMarkdown = await readFile(finalReportPath, 'utf8');
  const analyzeResult = JSON.parse(await readFile(analyzeResultPath, 'utf8'));
  const finalHtml = renderMarkdownDocument(finalMarkdown, {
    title: extractTitle(finalMarkdown, `X 日报 | ${runDate}`),
  });

  await copyFile(finalReportPath, resolve(publishedRunDir, 'final.md'));
  await writeFile(resolve(publishedRunDir, 'final.html'), finalHtml, 'utf8');
  await copyFile(analyzeResultPath, resolve(publishedRunDir, 'analyze.result.json'));
  if (fetchResultPath) {
    await copyFile(fetchResultPath, resolve(publishedRunDir, 'fetch.result.json'));
  }

  const reportKey = `reports/${runDate}/${runId}/final.html`;
  const markdownKey = `reports/${runDate}/${runId}/final.md`;
  const analyzeResultKey = `reports/${runDate}/${runId}/analyze.result.json`;
  const fetchResultKey = fetchResultPath ? `reports/${runDate}/${runId}/fetch.result.json` : null;
  const updatedAt = String(publishedAt ?? analyzeResult?.meta?.analyzedAt ?? new Date().toISOString());
  const links = buildReportLinks(runDate, runId, siteOrigin);
  const entry = {
    date: runDate,
    runId,
    title: extractTitle(finalMarkdown, `X 日报 | ${runDate}`),
    summary: extractSummary(finalMarkdown),
    reportKey,
    markdownKey,
    analyzeResultKey,
    fetchResultKey,
    updatedAt,
    reportUrl: links.reportUrl,
    rawUrl: links.rawUrl,
    quality: analyzeResult?.quality ?? null,
  };

  const previousIndex = previousIndexPath
    ? await readJsonIfExists(previousIndexPath, [])
    : [];
  const index = mergeIndexEntries(previousIndex, entry, 60);

  await mkdir(outputRoot, { recursive: true });
  await writeFile(resolve(outputRoot, 'latest.json'), JSON.stringify(entry, null, 2), 'utf8');
  await writeFile(resolve(outputRoot, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  return {
    runDate,
    runId,
    publishedRunDir,
    reportKey,
    markdownKey,
    analyzeResultKey,
    fetchResultKey,
    latestPath: resolve(outputRoot, 'latest.json'),
    indexPath: resolve(outputRoot, 'index.json'),
  };
}

function parseArgs(argv) {
  const options = {
    summaryPath: undefined,
    outputDir: undefined,
    previousIndexPath: undefined,
    siteOrigin: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--summary' && next) {
      options.summaryPath = next;
      index += 1;
      continue;
    }
    if (arg === '--output-dir' && next) {
      options.outputDir = next;
      index += 1;
      continue;
    }
    if (arg === '--previous-index' && next) {
      options.previousIndexPath = next;
      index += 1;
      continue;
    }
    if (arg === '--site-origin' && next) {
      options.siteOrigin = next;
      index += 1;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await publishRunArtifacts(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedAsMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (invokedAsMain) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
