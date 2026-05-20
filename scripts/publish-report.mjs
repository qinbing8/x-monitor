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
  const strongTokens = [];
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

  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, (_, strongText) => {
    const token = `@@STRONG${strongTokens.length}@@`;
    strongTokens.push(`<strong>${escapeHtml(strongText)}</strong>`);
    return token;
  });

  rendered = escapeHtml(rendered).replace(
    /(https?:\/\/[^\s<]+)/g,
    (match) => `<a href="${match}">${match}</a>`,
  );

  rendered = rendered
    .replace(/@@STRONG(\d+)@@/g, (_, index) => strongTokens[Number(index)] ?? '')
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

function renderReportStyles() {
  return [
    ':root { color-scheme: light; --page-bg: #ece7dc; --paper: #fffefa; --ink: #181613; --muted: #6f665b; --rule: #ded6ca; --rule-strong: #b9aa98; --accent: #1f5f8f; }',
    '* { box-sizing: border-box; }',
    'html { background: var(--page-bg); }',
    'body { margin: 0; background: var(--page-bg); color: var(--ink); font-family: Charter, "PingFang SC", "Noto Serif SC", "Source Han Serif SC", Georgia, serif; text-rendering: optimizeLegibility; }',
    '.report-shell { width: min(100%, 980px); margin: 0 auto; padding: 32px 24px 56px; }',
    '.report-document { max-width: 820px; min-height: calc(100vh - 88px); margin: 0 auto; padding: 58px 64px 72px; background: var(--paper); border: 1px solid var(--rule); box-shadow: 0 18px 50px rgba(31, 28, 24, 0.12); }',
    'h1, h2, h3 { color: #12100d; font-family: "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", Charter, Georgia, serif; font-weight: 700; line-height: 1.25; }',
    'h1 { margin: 0 0 1.8rem; padding-bottom: 1rem; border-bottom: 2px solid #181613; font-size: 2.35rem; }',
    'h2 { margin: 2.7rem 0 1rem; padding-top: 1.1rem; border-top: 1px solid var(--rule-strong); font-size: 1.32rem; }',
    'h2:first-of-type { margin-top: 2rem; }',
    'h3 { margin: 1.8rem 0 0.7rem; font-size: 1.12rem; }',
    'p, li { font-size: 1.02rem; line-height: 1.82; }',
    'p { margin: 0 0 1rem; }',
    'ul { margin: 0 0 1.35rem; padding-left: 1.25rem; }',
    'li { margin: 0.42rem 0; padding-left: 0.2rem; }',
    'li::marker { color: var(--accent); }',
    'strong { color: #111; font-weight: 700; }',
    'code { padding: 0.08rem 0.28rem; border: 1px solid #e2d8c9; border-radius: 4px; background: #f3eddf; font-family: Menlo, "Cascadia Code", "SFMono-Regular", Consolas, monospace; font-size: 0.92em; overflow-wrap: anywhere; }',
    'pre { overflow-x: auto; margin: 1.1rem 0 1.35rem; padding: 16px 18px; border-radius: 8px; background: #201b16; color: #f7f0e6; }',
    'pre code { padding: 0; border: 0; background: transparent; color: inherit; }',
    'a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 0.16em; overflow-wrap: anywhere; }',
    'a:hover { text-decoration-thickness: 2px; }',
    '@page { size: A4; margin: 20mm 22mm 22mm; }',
    '@media (max-width: 720px) { .report-shell { padding: 0; } .report-document { min-height: 100vh; padding: 32px 20px 52px; border: 0; box-shadow: none; } h1 { font-size: 1.75rem; } h2 { margin-top: 2rem; font-size: 1.18rem; } p, li { font-size: 1rem; } }',
    '@media print { html, body { background: #fff; } .report-shell { width: auto; margin: 0; padding: 0; } .report-document { max-width: none; min-height: 0; padding: 0; border: 0; box-shadow: none; } h1 { margin-bottom: 1.6rem; } h2 { break-after: avoid; } p, li { orphans: 2; widows: 2; } a { color: inherit; } }',
  ];
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
    ...renderReportStyles().map((rule) => `    ${rule}`),
    '  </style>',
    '</head>',
    '<body>',
    '  <main class="report-shell">',
    '    <article class="report-document">',
    body.map((chunk) => `      ${chunk}`).join('\n'),
    '    </article>',
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
