#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runFetch } from './fetch.mjs';
import { runAnalyze } from './analyze.mjs';
import { prepareDailyRoster } from './roster.mjs';

export function parseArgs(argv) {
  const out = {
    mode: 'run',
    configPath: undefined,
    analysisProfile: undefined,
    analyzeInputPath: undefined,
    date: undefined,
    seedCsvPath: undefined,
    batchSize: undefined,
    referenceTime: undefined,
    skipPrecheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--mode' && next) { out.mode = next; i += 1; continue; }
    if (arg === '--config' && next) { out.configPath = next; i += 1; continue; }
    if (arg === '--analysis-profile' && next) { out.analysisProfile = next; i += 1; continue; }
    if (arg === '--analyze-input' && next) { out.analyzeInputPath = next; i += 1; continue; }
    if (arg === '--date' && next) { out.date = next; i += 1; continue; }
    if (arg === '--seed-csv' && next) { out.seedCsvPath = next; i += 1; continue; }
    if (arg === '--batch-size' && next) { out.batchSize = Number(next); i += 1; continue; }
    if (arg === '--reference-time' && next) { out.referenceTime = next; i += 1; continue; }
    if (arg === '--skip-precheck') { out.skipPrecheck = true; continue; }
  }
  return out;
}

function validateOptions(options) {
  if (options.mode !== 'analyze' && options.analyzeInputPath) {
    throw new Error('--analyze-input is only supported in analyze mode');
  }
  if (options.analyzeInputPath && options.date) {
    throw new Error('--date cannot be combined with --analyze-input');
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  validateOptions(options);
  const runFetchImpl = dependencies.runFetchImpl ?? runFetch;
  const runAnalyzeImpl = dependencies.runAnalyzeImpl ?? runAnalyze;
  const prepareDailyRosterImpl = dependencies.prepareDailyRosterImpl ?? prepareDailyRoster;
  if (!['fetch', 'analyze', 'run'].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }

  const summary = { mode: options.mode };
  if (options.mode === 'fetch' || options.mode === 'run') {
    if (!options.seedCsvPath) {
      summary.roster = await prepareDailyRosterImpl({
        configPath: options.configPath,
        date: options.date,
      });
    }
    summary.fetch = await runFetchImpl({
      configPath: options.configPath,
      date: options.date,
      seedCsvPath: options.seedCsvPath,
      batchSize: options.batchSize,
      referenceTime: options.referenceTime,
      skipPrecheck: options.skipPrecheck,
    });
  }
  if (options.mode === 'analyze' || options.mode === 'run') {
    summary.analyze = await runAnalyzeImpl({
      configPath: options.configPath,
      date: options.date,
      analysisProfile: options.analysisProfile,
      analyzeInputPath: options.analyzeInputPath,
    });
  }
  return summary;
}

const invokedAsMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (invokedAsMain) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
