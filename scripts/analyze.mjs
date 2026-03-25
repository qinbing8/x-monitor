import { readFile } from 'node:fs/promises';
import { loadConfig, loadSourceDocuments, resolveMaybeRelative } from './config-loader.mjs';
import { resolveAnalysisProfile } from './provider-resolver.mjs';
import { ensureRunDir, readJsonArtifact, writeJsonArtifact, writeTextArtifact, resolveRunDate, findLatestRunDir } from './artifact-store.mjs';
import { postChatCompletions, withRetry } from './openai-compatible-client.mjs';

const MIN_ANALYZE_TIMEOUT_MS = 300000;
const MIN_TOTAL_ACCOUNTS_FOR_QUALITY_GATE = 10;
const MIN_HEALTHY_COVERED_ACCOUNTS = 3;
const MIN_HEALTHY_TWEETS = 12;

const NOISE_PATTERNS = [
  /^test\b/i,
  /placeholder/i,
  /lorem\s+ipsum/i,
  /sample\s+(tweet|post|text)/i,
  /this\s+is\s+a\s+test/i,
  /no\s+matching\s+posts?\s+found/i,
  /如果有实际数据会替换/,
  /will\s+be\s+replaced\s+with\s+actual/i,
  /example\s+(tweet|post|content)/i,
];
const MIN_SIGNAL_TEXT_LENGTH = 15;

export function filterNoiseTweets(items) {
  const signal = [];
  const noise = [];
  for (const item of items) {
    const text = String(item.text ?? '').trim();
    const isNoise = text.length < MIN_SIGNAL_TEXT_LENGTH
      || NOISE_PATTERNS.some((re) => re.test(text));
    if (isNoise) {
      noise.push({ ...item, noiseReason: text.length < MIN_SIGNAL_TEXT_LENGTH ? 'too_short' : 'pattern_match' });
    } else {
      signal.push(item);
    }
  }
  return { signal, noise };
}

function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => String(vars[key] ?? ''));
}

export function resolveAnalyzeTimeoutMs(timeoutMs) {
  const parsed = Number(timeoutMs);
  const requestedTimeoutMs = Number.isFinite(parsed) ? parsed : 0;
  return Math.max(MIN_ANALYZE_TIMEOUT_MS, requestedTimeoutMs);
}

function summarizeCoverage(accounts) {
  const totalAccountCount = accounts.length;
  const coveredAccountCount = accounts.filter((account) => account.status === 'covered').length;
  const noTweetAccountCount = accounts.filter((account) => account.status === 'no_tweets_found').length;
  const failedAccountCount = accounts.filter((account) => account.status === 'fetch_failed').length;
  const incompleteAccountCount = accounts.filter((account) => account.status === 'incomplete').length;
  return {
    totalAccountCount,
    coveredAccountCount,
    noTweetAccountCount,
    failedAccountCount,
    incompleteAccountCount,
  };
}

export function assessBriefQuality({ coverage, tweetCount, signalTweetCount }) {
  const safeCoverage = coverage ?? summarizeCoverage([]);
  const totalAccountCount = Number(safeCoverage.totalAccountCount ?? 0) || 0;
  const coveredAccountCount = Number(safeCoverage.coveredAccountCount ?? 0) || 0;
  const incompleteAccountCount = Number(safeCoverage.incompleteAccountCount ?? 0) || 0;
  const failedAccountCount = Number(safeCoverage.failedAccountCount ?? 0) || 0;
  const safeTweetCount = Number(tweetCount ?? 0) || 0;
  const safeSignalCount = Number(signalTweetCount ?? safeTweetCount) || 0;
  const coverageRate = totalAccountCount > 0 ? coveredAccountCount / totalAccountCount : 0;
  const signalRate = safeTweetCount > 0 ? safeSignalCount / safeTweetCount : 0;
  const hasCoverageRisk = failedAccountCount > 0 || incompleteAccountCount > 0;
  const lowCoverage = totalAccountCount >= MIN_TOTAL_ACCOUNTS_FOR_QUALITY_GATE
    && (coveredAccountCount < MIN_HEALTHY_COVERED_ACCOUNTS || safeSignalCount < MIN_HEALTHY_TWEETS || coverageRate < 0.1);

  if (safeSignalCount === 0 || coveredAccountCount === 0) {
    return {
      status: 'empty',
      needsReview: true,
      coverageRate,
      signalRate,
      note: `No window-valid signal tweet evidence was captured. Current coverage is ${coveredAccountCount}/${totalAccountCount} accounts with ${safeSignalCount} signal tweets (${safeTweetCount} total, ${safeTweetCount - safeSignalCount} noise filtered).`,
    };
  }

  if (hasCoverageRisk || lowCoverage) {
    const reasons = [];
    if (lowCoverage) reasons.push(`limited sample (${coveredAccountCount}/${totalAccountCount} accounts, ${safeSignalCount} signal tweets)`);
    if (incompleteAccountCount > 0) reasons.push(`${incompleteAccountCount} incomplete accounts`);
    if (failedAccountCount > 0) reasons.push(`${failedAccountCount} failed accounts`);
    if (signalRate < 0.5 && safeTweetCount > 0) reasons.push(`low signal-to-noise ratio (${Math.round(signalRate * 100)}%)`);
    return {
      status: 'degraded',
      needsReview: true,
      coverageRate,
      signalRate,
      note: `Low-coverage digest: ${reasons.join('; ')}. Treat this brief as partial evidence, not a complete daily view.`,
    };
  }

  return {
    status: 'ok',
    needsReview: false,
    coverageRate,
    signalRate,
    note: 'Coverage completed without detected fetch failures or material gaps.',
  };
}

export function injectQualityBanner(markdown, quality) {
  const text = String(markdown ?? '').trim();
  if (!text) return text;
  if (!quality || quality.status === 'ok') return text;

  const icon = quality.status === 'empty' ? '🟥' : '⚠️';
  const banner = `> ${icon} ${quality.note}`;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.startsWith('# ')) {
    return [lines[0], '', banner, ...lines.slice(1)].join('\n').replace(/\n{3,}/g, '\n\n');
  }
  return `${banner}\n\n${text}`;
}

export function buildTweetEvidenceBlock({ meta = {}, accounts = [], items = [], warnings = [] }) {
  const coverage = summarizeCoverage(accounts);
  const evidence = {
    meta: {
      source_provider: meta.sourceProvider ?? 'grok',
      fetched_at: meta.fetchedAt ?? null,
      time_window_hours: meta.timeWindowHours ?? 24,
      total_accounts: coverage.totalAccountCount,
      covered_accounts: coverage.coveredAccountCount,
      no_tweet_accounts: coverage.noTweetAccountCount,
      failed_accounts: coverage.failedAccountCount,
      incomplete_accounts: coverage.incompleteAccountCount,
      total_tweets: items.length,
    },
    coverage: accounts.map((account) => ({
      seed_id: account.seedId,
      handle: account.handle,
      display_name: account.displayName,
      status: account.status,
      tweet_count: account.tweetCount,
      notes: account.notes,
    })),
    tweets: items.map((item) => ({
      seed_id: item.source?.seedId ?? null,
      handle: item.username,
      display_name: item.displayName,
      tweet_id: item.tweetId,
      created_at: item.createdAt,
      text: item.text,
      original_url: item.originalUrl,
      batch_id: item.batchId,
    })),
    warnings,
  };
  return JSON.stringify(evidence, null, 2);
}

export async function runAnalyze({ configPath, date, analysisProfile, fetchImpl } = {}) {
  const { config, skillRoot } = await loadConfig(configPath);
  const sourceDocs = await loadSourceDocuments(config, skillRoot);
  const profile = resolveAnalysisProfile(config, sourceDocs, analysisProfile || config.analysis.activeProfile);
  const effectiveTimeoutMs = resolveAnalyzeTimeoutMs(profile.timeoutMs);
  const runDate = resolveRunDate(date);
  const fetchRunDir = await findLatestRunDir(skillRoot, config.defaults.outputDir, runDate);
  const runDir = await ensureRunDir(skillRoot, config.defaults.outputDir, runDate);
  const fetchResult = await readJsonArtifact(fetchRunDir, config.runtime.artifacts.fetchResult);
  const items = Array.isArray(fetchResult?.items) ? fetchResult.items : [];
  const accounts = Array.isArray(fetchResult?.accounts) ? fetchResult.accounts : [];
  const warnings = Array.isArray(fetchResult?.warnings) ? fetchResult.warnings : [];

  if (accounts.length === 0 && items.length === 0) {
    throw new Error('No fetched tweet evidence found for analysis');
  }

  const { signal: signalItems, noise: noiseItems } = filterNoiseTweets(items);

  const promptPath = resolveMaybeRelative(skillRoot, profile.promptFile);
  const promptTemplate = await readFile(promptPath, 'utf8');
  const tweetEvidenceBlock = buildTweetEvidenceBlock({
    meta: fetchResult.meta,
    accounts,
    items: signalItems,
    warnings,
  });
  const renderedPrompt = renderTemplate(promptTemplate, {
    REPORT_DATE: runDate,
    TWEET_EVIDENCE_BLOCK: tweetEvidenceBlock,
  });

  const analyzeInput = {
    task: {
      goal: 'Screen the last 24 hours of X tweets into an editorial daily brief',
      analysisProfile: profile.name,
      reportDate: runDate,
      timeoutMs: effectiveTimeoutMs,
    },
    evidence: {
      meta: fetchResult.meta,
      accounts,
      items,
      warnings,
    },
  };
  const analyzeInputPath = await writeJsonArtifact(runDir, config.runtime.artifacts.analyzeInput, analyzeInput);

  const completion = await withRetry(
    () => postChatCompletions({
      baseUrl: profile.provider.baseUrl,
      apiKey: profile.provider.apiKey,
      model: profile.modelId,
      timeoutMs: effectiveTimeoutMs,
      temperature: profile.temperature,
      maxTokens: profile.maxOutputTokens,
      messages: [{ role: 'user', content: renderedPrompt }],
      fetchImpl,
    }),
    profile.retry,
  );

  const outputText = completion.text.trim();
  const coverage = summarizeCoverage(accounts);
  const quality = assessBriefQuality({
    coverage,
    tweetCount: items.length,
    signalTweetCount: signalItems.length,
  });
  const finalMarkdown = injectQualityBanner(outputText, quality);
  const analyzeResult = {
    meta: {
      analysisProfile: profile.name,
      provider: profile.providerRef,
      model: profile.modelId,
      analyzedAt: new Date().toISOString(),
      analyzeInputPath,
      timeoutMs: effectiveTimeoutMs,
      tweetCount: items.length,
      signalTweetCount: signalItems.length,
      noiseTweetCount: noiseItems.length,
      coverage,
    },
    answer: {
      markdown: finalMarkdown,
    },
    quality,
  };
  const analyzeResultPath = await writeJsonArtifact(runDir, config.runtime.artifacts.analyzeResult, analyzeResult);
  const finalReportPath = await writeTextArtifact(runDir, config.runtime.artifacts.finalReport, finalMarkdown);
  return {
    runDir,
    analyzeInputPath,
    analyzeResultPath,
    finalReportPath,
    analysisProfile: profile.name,
    tweetCount: items.length,
  };
}
