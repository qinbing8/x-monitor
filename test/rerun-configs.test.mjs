import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { readJsonFile } from '../scripts/config-loader.mjs';

async function loadConfig(relativePath) {
  return readJsonFile(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)));
}

function assertAnalysisProviderMappings(config, label) {
  for (const providerRef of ['gpt', 'gpt-backup', 'claude']) {
    assert.equal(
      config.providers?.[providerRef]?.mapping?.api,
      'api',
      `${label} provider ${providerRef} must map api`,
    );
  }
}

test('rerun config for gpt-5.4 targets router-gpt with a self-contained active profile', async () => {
  const config = await loadConfig('config.rerun.gpt54.json');
  assert.equal(config.analysis.activeProfile, 'gpt54-rerun');
  assert.equal(config.analysis.profiles['gpt54-rerun'].providerRef, 'gpt');
  assert.equal(config.analysis.profiles['gpt54-rerun'].modelRef, 'gpt-main-rerun');
  assert.equal(config.models['gpt-main'].modelId, 'gpt-5.4-xhigh');
  assert.equal(config.models['gpt-main-rerun'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main-rerun'].modelId, 'gpt-5.4');
  assert.equal(config.models['gpt-main-mini'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main-mini'].modelId, 'gpt-5.4');
  assertAnalysisProviderMappings(config, 'config.rerun.gpt54.json');
});

test('rerun config for gpt-5.4-high targets router-gpt with the expected model id', async () => {
  const config = await loadConfig('config.rerun.gpt54high.json');
  assert.equal(config.analysis.activeProfile, 'gpt54-high-rerun');
  assert.equal(config.analysis.profiles['gpt54-high-rerun'].providerRef, 'gpt');
  assert.equal(config.analysis.profiles['gpt54-high-rerun'].modelRef, 'gpt-main-high-rerun');
  assert.equal(config.models['gpt-main'].modelId, 'gpt-5.4-xhigh');
  assert.equal(config.models['gpt-main-high-rerun'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main-high-rerun'].modelId, 'gpt-5.4-high');
  assert.equal(config.models['gpt-main-mini'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main-mini'].modelId, 'gpt-5.4');
  assertAnalysisProviderMappings(config, 'config.rerun.gpt54high.json');
});

test('rerun config for gpt-5.4-high 15m keeps the extended timeout and expected model id', async () => {
  const config = await loadConfig('config.rerun.gpt54high.15m.json');
  assert.equal(config.analysis.activeProfile, 'gpt54-high-rerun-15m');
  assert.equal(config.analysis.profiles['gpt54-high-rerun-15m'].providerRef, 'gpt');
  assert.equal(config.analysis.profiles['gpt54-high-rerun-15m'].modelRef, 'gpt-main-high-rerun');
  assert.equal(config.analysis.profiles['gpt54-high-rerun-15m'].timeoutMs, 900000);
  assert.equal(config.models['gpt-main'].modelId, 'gpt-5.4-xhigh');
  assert.equal(config.models['gpt-main-high-rerun'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main-high-rerun'].modelId, 'gpt-5.4-high');
  assert.equal(config.models['gpt-main-mini'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main-mini'].modelId, 'gpt-5.4');
  assertAnalysisProviderMappings(config, 'config.rerun.gpt54high.15m.json');
});

test('rerun config for screening gpt-5.4 upgrades only roster and screening stages', async () => {
  const config = await loadConfig('config.rerun.screening-gpt54.json');
  assert.equal(config.analysis.activeProfile, 'gpt54-screening-rerun');
  assert.equal(config.analysis.profiles['gpt54-screening-rerun'].providerRef, 'gpt');
  assert.equal(config.analysis.profiles['gpt54-screening-rerun'].modelRef, 'gpt-main');
  assert.equal(config.analysis.profiles['gpt54-screening-rerun'].rosterModelRef, 'gpt-main-rerun');
  assert.equal(config.analysis.profiles['gpt54-screening-rerun'].screeningModelRef, 'gpt-main-rerun');
  assert.equal(config.models['gpt-main'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main'].modelId, 'gpt-5.4-xhigh');
  assert.equal(config.models['gpt-main-rerun'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main-rerun'].modelId, 'gpt-5.4');
  assert.equal(config.models['gpt-main-mini'].providerRef, 'gpt');
  assert.equal(config.models['gpt-main-mini'].modelId, 'gpt-5.4');
  assert.equal(config.runtime.artifacts.fetchTweetIndexCsv, 'fetch.tweet-index.csv');
  assertAnalysisProviderMappings(config, 'config.rerun.screening-gpt54.json');
});
