import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { loadConfig, loadSourceDocuments } from '../scripts/config-loader.mjs';
import { resolveProvider, resolveAnalysisProfile, resolveFetchProfile } from '../scripts/provider-resolver.mjs';
import { FIXTURE_OPENCLAW, FIXTURE_SEARCH, createMockSkillFixture } from '../support/fixtures.mjs';

test('resolveProvider maps provider fields from source documents', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const { config, skillRoot } = await loadConfig(fixture.configPath);
    const sourceDocs = await loadSourceDocuments(config, skillRoot);

    const provider = resolveProvider(config, sourceDocs, 'grok');
    assert.equal(provider.providerRef, 'grok');
    assert.equal(provider.baseUrl, FIXTURE_SEARCH.grok.apiUrl);
    assert.equal(provider.apiKey, FIXTURE_SEARCH.grok.apiKey);
    assert.equal(provider.defaultModel, FIXTURE_SEARCH.grok.model);
  } finally {
    await fixture.cleanup();
  }
});

test('provider resolution switches analysis profile between gpt and claude', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const { config, skillRoot } = await loadConfig(fixture.configPath);
    const sourceDocs = await loadSourceDocuments(config, skillRoot);

    const fetchProfile = resolveFetchProfile(config, sourceDocs, 'grok-default');
    assert.equal(fetchProfile.model, FIXTURE_SEARCH.grok.model);
    assert.equal(fetchProfile.provider.baseUrl, FIXTURE_SEARCH.grok.apiUrl);

    const gptProfile = resolveAnalysisProfile(config, sourceDocs, 'gpt-default');
    assert.equal(gptProfile.modelId, 'gpt-5.4(xhigh)');
    assert.equal(gptProfile.provider.baseUrl, FIXTURE_OPENCLAW.models.providers['router-gpt'].baseUrl);

    const claudeProfile = resolveAnalysisProfile(config, sourceDocs, 'claude-default');
    assert.equal(claudeProfile.modelId, 'claude-sonnet-4-6');
    assert.equal(claudeProfile.provider.baseUrl, FIXTURE_OPENCLAW.models.providers.anyrouter.baseUrl);
  } finally {
    await fixture.cleanup();
  }
});

test('resolveAnalysisProfile rejects model refs bound to a different provider', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    config.models['claude-main'].providerRef = 'gpt';
    await writeFile(fixture.configPath, JSON.stringify(config, null, 2));

    const { config: loadedConfig, skillRoot } = await loadConfig(fixture.configPath);
    const sourceDocs = await loadSourceDocuments(loadedConfig, skillRoot);
    assert.throws(
      () => resolveAnalysisProfile(loadedConfig, sourceDocs, 'claude-default'),
      /bound to provider gpt, not claude/,
    );
  } finally {
    await fixture.cleanup();
  }
});
