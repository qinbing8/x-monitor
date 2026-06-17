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

function isTweetSourceUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    const hostname = url.hostname.toLowerCase();
    const isXHost = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(hostname);
    return isXHost && /\/status(?:es)?\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function trimUrlTrailingPunctuation(value) {
  return String(value ?? '').replace(/[),.;:!?，。；：！？、]+$/u, '');
}

function findTweetSourceLink(markdown) {
  const text = String(markdown ?? '');
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = markdownLinkPattern.exec(text))) {
    const href = trimUrlTrailingPunctuation(match[2]);
    if (isTweetSourceUrl(href)) {
      return {
        href,
        start: match.index,
        end: match.index + match[0].length,
      };
    }
  }

  const bareUrlPattern = /https?:\/\/[^\s<]+/g;
  while ((match = bareUrlPattern.exec(text))) {
    const href = trimUrlTrailingPunctuation(match[0]);
    if (isTweetSourceUrl(href)) {
      return {
        href,
        start: match.index,
        end: match.index + href.length,
      };
    }
  }

  return null;
}

function renderInlineMarkdown(text, options = {}) {
  const codeTokens = [];
  const linkTokens = [];
  const strongTokens = [];
  const tweetSourceLinkMode = options.tweetSourceLinkMode ?? 'full';
  let rendered = String(text ?? '')
    .replace(/`([^`]+)`/g, (_, code) => {
      const token = `@@CODE${codeTokens.length}@@`;
      codeTokens.push(`<code>${escapeHtml(code)}</code>`);
      return token;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) => {
      const token = `@@LINK${linkTokens.length}@@`;
      if (isTweetSourceUrl(href) && tweetSourceLinkMode === 'compact') {
        linkTokens.push(renderTweetSourceLink(href));
      } else if (isTweetSourceUrl(href) && tweetSourceLinkMode === 'suppress') {
        linkTokens.push('');
      } else {
        linkTokens.push(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
      }
      return token;
    });

  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, (_, strongText) => {
    const token = `@@STRONG${strongTokens.length}@@`;
    strongTokens.push(`<strong>${escapeHtml(strongText)}</strong>`);
    return token;
  });

  rendered = escapeHtml(rendered).replace(
    /(https?:\/\/[^\s<]+)/g,
    (match) => {
      const href = trimUrlTrailingPunctuation(match);
      const suffix = match.slice(href.length);
      if (isTweetSourceUrl(href) && tweetSourceLinkMode === 'compact') {
        return `${renderTweetSourceLink(href)}${escapeHtml(suffix)}`;
      }
      if (isTweetSourceUrl(href) && tweetSourceLinkMode === 'suppress') return escapeHtml(suffix);
      return `<a href="${match}">${match}</a>`;
    },
  );

  rendered = rendered
    .replace(/@@STRONG(\d+)@@/g, (_, index) => strongTokens[Number(index)] ?? '')
    .replace(/@@CODE(\d+)@@/g, (_, index) => codeTokens[Number(index)] ?? '')
    .replace(/@@LINK(\d+)@@/g, (_, index) => linkTokens[Number(index)] ?? '');

  return rendered;
}

function cleanupSourceLinkText(text) {
  return String(text ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,，。；;:：])/g, '$1')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/(?:原文链接|原文|链接)\s*[:：]?\s*$/u, '')
    .replace(/[ \t]*(?:[|｜/]|-|—|、|,|，|;|；|:|：)+\s*$/u, '')
    .trim();
}

function renderTweetSourceLink(href) {
  return `<a href="${escapeHtml(href)}" class="source-link">查看原文</a>`;
}

function renderHighValueTweetMarkdown(text) {
  const sourceLink = findTweetSourceLink(text);
  if (!sourceLink) return renderInlineMarkdown(text);

  const displayText = cleanupSourceLinkText(`${String(text ?? '').slice(0, sourceLink.start)}${String(text ?? '').slice(sourceLink.end)}`);
  const renderedText = displayText ? renderInlineMarkdown(displayText, { tweetSourceLinkMode: 'compact' }) : '';
  const renderedLink = renderTweetSourceLink(sourceLink.href);
  return renderedText ? `${renderedText} ${renderedLink}` : renderedLink;
}

function flushParagraph(paragraphLines, output, renderOptions = {}) {
  if (paragraphLines.length === 0) return;
  const rendered = renderInlineMarkdown(paragraphLines.join(' '), renderOptions).trim();
  if (rendered) output.push(`<p>${rendered}</p>`);
  paragraphLines.length = 0;
}

function closeListIfNeeded(state, output) {
  if (!state.inList) return;
  output.push('</ul>');
  state.inList = false;
}

function renderReportStyles() {
  return [
    ':root { color-scheme: light; --page-bg: #f7f8fb; --paper: #ffffff; --ink: #111827; --muted: #5b6472; --rule: #d8dee8; --rule-soft: #eef1f6; --accent: #0f766e; }',
    '* { box-sizing: border-box; }',
    'html { background: var(--page-bg); }',
    'body { margin: 0; background: var(--page-bg); color: var(--ink); font-family: "Inter", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif; text-rendering: optimizeLegibility; }',
    '.report-shell { width: min(100%, 920px); margin: 0 auto; padding: 44px 24px 64px; }',
    '.report-document { max-width: 760px; min-height: calc(100vh - 108px); margin: 0 auto; padding: 0; background: transparent; }',
    'h1, h2, h3 { color: var(--ink); font-weight: 700; line-height: 1.28; }',
    'h1 { margin: 0 0 1.9rem; padding-bottom: 1rem; border-bottom: 1px solid var(--rule); font-size: 2.1rem; }',
    'h2 { margin: 2.35rem 0 0.9rem; padding-top: 0.95rem; border-top: 1px solid var(--rule-soft); font-size: 1.22rem; }',
    'h2:first-of-type { margin-top: 1.65rem; }',
    'h3 { margin: 1.55rem 0 0.65rem; font-size: 1.06rem; }',
    'p, li { font-size: 1rem; line-height: 1.78; }',
    'p { margin: 0 0 0.95rem; color: var(--muted); }',
    'ul { margin: 0 0 1.2rem; padding-left: 1.15rem; }',
    'li { margin: 0.36rem 0; padding-left: 0.16rem; }',
    'li::marker { color: var(--accent); }',
    'strong { color: var(--ink); font-weight: 700; }',
    'code { padding: 0.08rem 0.26rem; border: 1px solid #dbe7e5; border-radius: 4px; background: #ecfdf9; color: #075f58; font-family: Menlo, "Cascadia Code", "SFMono-Regular", Consolas, monospace; font-size: 0.92em; overflow-wrap: anywhere; }',
    'pre { overflow-x: auto; margin: 1rem 0 1.25rem; padding: 14px 16px; border-radius: 8px; background: #111827; color: #f8fafc; }',
    'pre code { padding: 0; border: 0; background: transparent; color: inherit; }',
    'a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 0.16em; overflow-wrap: anywhere; }',
    'a:hover { text-decoration-thickness: 2px; }',
    '.source-link { white-space: nowrap; font-weight: 600; }',
    '@page { size: A4; margin: 20mm 22mm 22mm; }',
    '@media (max-width: 720px) { .report-shell { padding: 28px 18px 48px; } .report-document { min-height: 100vh; } h1 { font-size: 1.65rem; } h2 { margin-top: 1.9rem; font-size: 1.14rem; } p, li { font-size: 0.98rem; } }',
    '@media print { html, body { background: #fff; } .report-shell { width: auto; margin: 0; padding: 0; } .report-document { max-width: none; min-height: 0; padding: 0; } h1 { margin-bottom: 1.6rem; } h2 { break-after: avoid; } p, li { orphans: 2; widows: 2; } a { color: inherit; } }',
  ];
}

function renderOptionsForSection(inHighValueTweetSection) {
  return {
    tweetSourceLinkMode: inHighValueTweetSection ? 'compact' : 'suppress',
  };
}

export function renderMarkdownDocument(markdown, options = {}) {
  const lines = String(markdown ?? '').replace(/\r/g, '').split('\n');
  const body = [];
  const paragraphLines = [];
  const listState = { inList: false };
  let inHighValueTweetSection = false;
  let inCodeBlock = false;
  let codeLines = [];

  const flushCodeBlock = () => {
    if (codeLines.length === 0) return;
    body.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushParagraph(paragraphLines, body, renderOptionsForSection(inHighValueTweetSection));
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
      flushParagraph(paragraphLines, body, renderOptionsForSection(inHighValueTweetSection));
      closeListIfNeeded(listState, body);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph(paragraphLines, body, renderOptionsForSection(inHighValueTweetSection));
      closeListIfNeeded(listState, body);
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      if (level <= 2) {
        inHighValueTweetSection = text.includes('高价值推文');
      }
      body.push(`<h${level} id="${slugifyHeading(text)}">${renderInlineMarkdown(text)}</h${level}>`);
      continue;
    }

    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch) {
      flushParagraph(paragraphLines, body, renderOptionsForSection(inHighValueTweetSection));
      if (!listState.inList) {
        body.push('<ul>');
        listState.inList = true;
      }
      const itemText = listMatch[1].trim();
      const renderedItem = inHighValueTweetSection
        ? renderHighValueTweetMarkdown(itemText)
        : renderInlineMarkdown(itemText, renderOptionsForSection(false)).trim();
      if (renderedItem) body.push(`<li>${renderedItem}</li>`);
      continue;
    }

    closeListIfNeeded(listState, body);
    paragraphLines.push(trimmed);
  }

  if (inCodeBlock) flushCodeBlock();
  flushParagraph(paragraphLines, body, renderOptionsForSection(inHighValueTweetSection));
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
    if (/^##\s+(?:今日亮点|今日摘要|今日要点摘要)(?:\s|（|\(|$)/.test(trimmed)) {
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
    .find((line) => line
      && !/^#+\s+/.test(line)
      && !/^>\s+/.test(line)
      && !/^-\s*$/.test(line));
  return stripInlineMarkdown(fallbackLine ?? '').slice(0, 120);
}

function stripMaintenanceSections(markdown) {
  const maintenanceHeadingPattern = /^##\s+(?:覆盖与风险|抓取覆盖与缺口|抓取诊断|下一步建议)\s*$/;
  const maintenanceNoticePattern = /^>\s+.*(?:质量门控|Low-coverage|No window-valid|coverage|partial evidence|Grok|fetch|fallback 模型|主终稿模型失败|终稿模型|请求失败|结构过弱|诊断|覆盖|风险|证据不足|本日报仅代表部分样本)/i;
  const lines = String(markdown ?? '').replace(/\r/g, '').split('\n');
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      skipping = maintenanceHeadingPattern.test(trimmed);
      if (skipping) continue;
    }
    if (/请检查模型可用性|Invalid API key/i.test(trimmed)) {
      kept.push(line);
      continue;
    }
    if (maintenanceNoticePattern.test(trimmed)) continue;
    if (!skipping) kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
  const maintenancePath = `/maintenance/${runDate}/${runId}`;
  return {
    reportUrl: normalizedOrigin ? `${normalizedOrigin}${reportPath}` : reportPath,
    rawUrl: normalizedOrigin ? `${normalizedOrigin}${rawPath}` : rawPath,
    maintenanceUrl: normalizedOrigin ? `${normalizedOrigin}${maintenancePath}` : maintenancePath,
  };
}

function buildMaintenanceArtifact({ runDate, runId, analyzeResult, reportKey, markdownKey, analyzeResultKey, fetchResultKey }) {
  const meta = analyzeResult?.meta ?? {};
  return {
    run: {
      date: runDate,
      runId,
      analyzedAt: meta.analyzedAt ?? null,
      analysisProfile: meta.analysisProfile ?? null,
      model: meta.briefModel ?? meta.model ?? null,
    },
    quality: analyzeResult?.quality ?? null,
    coverage: meta.coverage ?? null,
    fetchDiagnosis: meta.fetchDiagnosis ?? null,
    counts: {
      tweetCount: meta.tweetCount ?? null,
      signalTweetCount: meta.signalTweetCount ?? null,
      promptSignalTweetCount: meta.promptSignalTweetCount ?? null,
      omittedSignalTweetCount: meta.omittedSignalTweetCount ?? null,
      noiseTweetCount: meta.noiseTweetCount ?? null,
      warningCount: meta.warningCount ?? null,
    },
    pipeline: {
      answerSource: analyzeResult?.answer?.source ?? null,
      generatedBy: analyzeResult?.answer?.generatedBy ?? null,
      generatedByFallbackModel: meta.generatedByFallbackModel ?? false,
      candidateSelectionMode: meta.candidateSelectionMode ?? null,
      screeningChunkCount: meta.screeningChunkCount ?? null,
      screeningCandidateCount: meta.screeningCandidateCount ?? null,
      screeningFallbackChunkCount: meta.screeningFallbackChunkCount ?? null,
      evidenceBlockMode: meta.evidenceBlockMode ?? null,
      summaryChunkCount: meta.summaryChunkCount ?? null,
      summaryFailedChunkCount: meta.summaryFailedChunkCount ?? null,
      finalDraftAttempts: meta.finalDraftAttempts ?? [],
      primaryBriefFailureSummary: meta.primaryBriefFailureSummary ?? null,
      modelAvailabilityIssue: meta.modelAvailabilityIssue ?? null,
      rosterScoringError: meta.rosterScoringError ?? null,
    },
    artifacts: {
      reportKey,
      markdownKey,
      analyzeResultKey,
      fetchResultKey,
    },
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
  const publicMarkdown = stripMaintenanceSections(finalMarkdown);
  const analyzeResult = JSON.parse(await readFile(analyzeResultPath, 'utf8'));
  const finalHtml = renderMarkdownDocument(publicMarkdown, {
    title: extractTitle(publicMarkdown, `X 日报 | ${runDate}`),
  });

  await writeFile(resolve(publishedRunDir, 'final.md'), publicMarkdown, 'utf8');
  await writeFile(resolve(publishedRunDir, 'final.html'), finalHtml, 'utf8');
  await copyFile(analyzeResultPath, resolve(publishedRunDir, 'analyze.result.json'));
  if (fetchResultPath) {
    await copyFile(fetchResultPath, resolve(publishedRunDir, 'fetch.result.json'));
  }

  const reportKey = `reports/${runDate}/${runId}/final.html`;
  const markdownKey = `reports/${runDate}/${runId}/final.md`;
  const analyzeResultKey = `reports/${runDate}/${runId}/analyze.result.json`;
  const fetchResultKey = fetchResultPath ? `reports/${runDate}/${runId}/fetch.result.json` : null;
  const maintenanceKey = `reports/${runDate}/${runId}/maintenance.json`;
  const maintenanceArtifact = buildMaintenanceArtifact({
    runDate,
    runId,
    analyzeResult,
    reportKey,
    markdownKey,
    analyzeResultKey,
    fetchResultKey,
  });
  await writeFile(resolve(publishedRunDir, 'maintenance.json'), JSON.stringify(maintenanceArtifact, null, 2), 'utf8');

  const updatedAt = String(publishedAt ?? analyzeResult?.meta?.analyzedAt ?? new Date().toISOString());
  const links = buildReportLinks(runDate, runId, siteOrigin);
  const entry = {
    date: runDate,
    runId,
    title: extractTitle(publicMarkdown, `X 日报 | ${runDate}`),
    summary: extractSummary(publicMarkdown),
    reportKey,
    markdownKey,
    analyzeResultKey,
    fetchResultKey,
    maintenanceKey,
    updatedAt,
    reportUrl: links.reportUrl,
    rawUrl: links.rawUrl,
    maintenanceUrl: links.maintenanceUrl,
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
    maintenanceKey,
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
