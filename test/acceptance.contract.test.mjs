import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function readUtf8(relativePath) {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

test('acceptance contract keeps Grok and GPT responsibilities separated', async () => {
  const grokPrompt = await readUtf8('../assets/prompts/grok-fetch.txt');
  const analyzePrompt = await readUtf8('../assets/prompts/gpt-analyze.txt');
  const rosterPrompt = await readUtf8('../assets/prompts/gpt-roster-score.txt');
  const exampleConfig = JSON.parse(await readUtf8('../config.example.json'));

  assert.match(grokPrompt, /职责只是抓取和整理原始推文内容/);
  assert.match(grokPrompt, /不要做价值判断/);
  assert.match(grokPrompt, /绝对只返回/);
  assert.match(grokPrompt, /开始时间（UTC）/);
  assert.match(grokPrompt, /结束时间（UTC）/);

  assert.match(analyzePrompt, /逐条阅读推文/);
  assert.match(analyzePrompt, /0-3 星价值判断/);
  assert.match(analyzePrompt, /闲聊/);

  assert.match(rosterPrompt, /低价值闲聊/);
  assert.match(rosterPrompt, /high_value_tweet_count/);
  assert.match(rosterPrompt, /low_value_chat_count/);

  const fetchProfile = exampleConfig.fetch.profiles['grok-default'];
  assert.equal(fetchProfile.seedCsvPath, './X列表关注者.daily.csv');
  assert.equal(fetchProfile.timeWindowHours, 24);
  assert.equal(exampleConfig.fetch.activeProfile, 'grok-default');
  assert.equal(exampleConfig.analysis.activeProfile, 'gpt-default');
  assert.equal(exampleConfig.providers.grok.role, 'fetch');
  assert.equal(exampleConfig.providers.gpt.role, 'analysis');
  assert.equal(exampleConfig.runtime.artifacts.fetchTweetIndexCsv, 'fetch.tweet-index.csv');
});
