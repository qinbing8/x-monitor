import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  expandHomePath,
  resolveMaybeRelative,
  readJsonFile,
  resolveJsonPath,
  loadConfig,
  loadSourceDocuments,
} from '../scripts/config-loader.mjs';
import { createMockSkillFixture } from '../support/fixtures.mjs';

test('expandHomePath expands tilde-prefixed paths', () => {
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  process.env.USERPROFILE = join(process.cwd(), 'fixture-home');
  process.env.HOME = '';
  try {
    assert.equal(
      expandHomePath('~/demo/config.json'),
      resolve(process.env.USERPROFILE, 'demo/config.json'),
    );
    assert.equal(expandHomePath('plain/path.json'), 'plain/path.json');
  } finally {
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
  }
});

test('resolveMaybeRelative keeps absolute paths and resolves relative ones', () => {
  const baseDir = join(process.cwd(), 'skill-root');
  const absolutePath = resolve(baseDir, 'config.json');
  assert.equal(resolveMaybeRelative(baseDir, './config.json'), absolutePath);
  assert.equal(resolveMaybeRelative(baseDir, absolutePath), absolutePath);
});

test('readJsonFile and resolveJsonPath read nested JSON values', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const json = await readJsonFile(fixture.configPath);
    assert.equal(resolveJsonPath(json, '$.defaults.mode'), 'run');
    assert.equal(resolveJsonPath(json, '$.fetch.activeProfile'), 'grok-default');
    assert.equal(resolveJsonPath(json, '$.missing.path'), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('loadConfig and loadSourceDocuments resolve config-relative source docs', async () => {
  const fixture = await createMockSkillFixture();
  try {
    const loaded = await loadConfig(fixture.configPath);
    assert.equal(loaded.configPath, fixture.configPath);
    assert.equal(loaded.skillRoot, fixture.skillRoot);
    assert.equal(loaded.config.defaults.mode, 'run');

    const docs = await loadSourceDocuments(loaded.config, loaded.skillRoot);
    assert.equal(docs.search.json.grok.model, 'grok-4.1-fast');
    assert.equal(docs.openclaw.json.models.providers.anyrouter.models[0].id, 'claude-sonnet-4-6');
  } finally {
    await fixture.cleanup();
  }
});
