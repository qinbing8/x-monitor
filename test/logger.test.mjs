import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogger } from '../scripts/logger.mjs';

async function captureStderr(fn) {
  const chunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, encoding, callback) => {
    chunks.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  });
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return chunks.join('');
}

test('createLogger writes structured stderr entries for enabled levels', async () => {
  const output = await captureStderr(async () => {
    const logger = createLogger({ level: 'info', scope: 'fetch' });
    logger.info('fetch_start', { seedCount: 2 });
  });
  const entry = JSON.parse(output.trim());
  assert.equal(entry.level, 'info');
  assert.equal(entry.scope, 'fetch');
  assert.equal(entry.event, 'fetch_start');
  assert.equal(entry.seedCount, 2);
});

test('createLogger child inherits level and suppresses disabled entries', async () => {
  const output = await captureStderr(async () => {
    const logger = createLogger({ level: 'warn', scope: 'fetch' }).child('llm');
    logger.info('hidden_entry', { ok: false });
    logger.error('visible_entry', { ok: true });
  });
  const lines = output.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.scope, 'fetch.llm');
  assert.equal(entry.event, 'visible_entry');
});
