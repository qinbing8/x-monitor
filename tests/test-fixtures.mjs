import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_OPENCLAW = {
  models: {
    providers: {
      'router-gpt': {
        baseUrl: 'https://gpt.example/v1',
        apiKey: 'gpt-key',
        models: [{ id: 'gpt-5.4(xhigh)' }],
      },
      anyrouter: {
        baseUrl: 'https://claude.example/v1',
        apiKey: 'claude-key',
        models: [{ id: 'claude-sonnet-4-6' }],
      },
    },
  },
};

export const FIXTURE_SEARCH = {
  grok: {
    apiUrl: 'https://grok.example/v1',
    apiKey: 'grok-key',
    model: 'grok-4.1-fast',
  },
};

export const FIXTURE_SEED_CSV = [
  '\uFEFFTweetID,Handle,Name,Bio,CanDM,AccountCreateDate,Location,FollowersCount,FollowingCount,TotalFavouritesByUser,MediaCount,UserPageURL,ProfileBannerURL,ProfileURL,AvatarURL,PostCount,Verified,IsBlueVerified',
  '"1599634054919245824","alice","Alice Maker","Builds tools, writes notes","false","2022/12/5 13:17:41","Shanghai","3","156","106","0","https://x.com/alice","","https://example.com/alice","https://cdn.example/alice.png","12","false","false"',
  '"1439790545048457225","bob","Bob Chen","Just fun","false","2021/9/20 11:16:41","","0","38","5","0","https://x.com/bob","","","https://cdn.example/bob.png","0","false","false"',
].join('\n');

export const FIXTURE_TWEET_FETCH_RESPONSE = [
  '整理如下：',
  '```csv',
  'username,tweet_id,created_at,text,original_url',
  '"alice","190001","2026-03-23T01:02:03Z","Shipped a new CLI for tracing agent runs. Demo: https://github.com/example/trace-cli","https://x.com/alice/status/190001"',
  '"alice","190002","2026-03-23T05:00:00Z","Quote: Strong write-up on eval-driven development. Worth reading.","https://x.com/alice/status/190002"',
  '```',
].join('\n');

export const FIXTURE_INVALID_FETCH_RESPONSE = '抱歉，当前无法返回符合要求的 CSV。';

export const FIXTURE_REFERENCE_TIME = '2026-03-23T14:21:05.770Z';

export const FIXTURE_PROSE_MIXED_FETCH_RESPONSE = [
  '整理如下：',
  '```csv',
  'username,tweet_id,created_at,text,original_url',
  '"没有符合条件的推文（过去24小时内无 original/repost/quote 类型推文，或所有查询无结果）。","","","",""',
  '"alice","190010","2026-03-23T03:00:00Z","Shipped a strict CSV parser fix.","https://x.com/alice/status/190010"',
  '"由于这些账号在过去24小时内没有符合条件的帖子（original posts"," reposts"," quotes，不含纯回复），因此没有数据行。","",""',
  '```',
  '没有更多数据。',
].join('\n');

export const FIXTURE_OUT_OF_WINDOW_FETCH_RESPONSE = [
  '```csv',
  'username,tweet_id,created_at,text,original_url',
  '"alice","190011","2026-03-22T15:30:00.000Z","Still inside the 24h window.","https://x.com/alice/status/190011"',
  '"alice","190012","2026-03-22T10:15:00.000Z","Outside the 24h window and must be dropped.","https://x.com/alice/status/190012"',
  '```',
].join('\n');

export const FIXTURE_PRECHECK_RESPONSE_DORMANT = [
  'username,last_tweet_date',
  '"alice","2026-03-23T01:00:00Z"',
  '"bob","2026-02-01T12:00:00Z"',
].join('\n');

export const FIXTURE_PRECHECK_RESPONSE_ALL_ACTIVE = [
  'username,last_tweet_date',
  '"alice","2026-03-23T01:00:00Z"',
  '"bob","2026-03-22T18:00:00Z"',
].join('\n');

export const FIXTURE_ANALYZE_MARKDOWN = [
  '# X 日报 | 2026-03-23',
  '',
  '## 今日要点摘要（Deep Brief）',
  '- 开发者工具仍是今天最值得看的主题，`@alice` 连发两条与 agent tracing 和评测工作流相关的高价值内容。',
  '',
  '## 编辑精选（Editor\'s Choice）',
  '- ★★★ @alice',
  '  - 发布新的 tracing CLI，并给出可直接查看的 Demo 链接。',
  '  - https://x.com/alice/status/190001',
  '',
  '## 高价值推文完整清单',
  '- ★★★ @alice 发布 tracing CLI，信息具体且可直接落地。https://x.com/alice/status/190001',
  '- ★★ @alice 引用了关于 eval-driven development 的深度文章。https://x.com/alice/status/190002',
  '',
  '## 抓取覆盖与缺口',
  '- @bob：未在抓取结果中观察到符合条件的推文，日报未做额外猜测。',
].join('\n');

export const FIXTURE_ANALYZE_MARKDOWN_PART1 = [
  '# X 日报 | 2026-03-23',
  '',
  '## 今日要点摘要（Deep Brief）',
  '- 开发者工具仍是今天最值得看的主题，`@alice` 连发两条与 agent tracing 和评测工作流相关的高价值内容。',
  '',
  '## 编辑精选（Editor\'s Choice）',
  '- ★★★ @alice',
  '  - 发布新的 tracing CLI，并给出可直接查看的 Demo 链接。',
  '  - https://x.com/alice/status/190001',
].join('\n');

export const FIXTURE_ANALYZE_MARKDOWN_PART2 = [
  '',
  '',
  '## 高价值推文完整清单',
  '- ★★★ @alice 发布 tracing CLI。https://x.com/alice/status/190001',
  '- ★★ @alice 引用 eval-driven development 文章。https://x.com/alice/status/190002',
  '',
  '## 抓取覆盖与缺口',
  '- @bob：未观察到符合条件的推文。',
].join('\n');

export async function createMockSkillFixture() {
  const root = await mkdtemp(join(tmpdir(), 'x-monitor-fixture-'));
  const skillRoot = join(root, 'skill');
  await mkdir(join(skillRoot, 'assets', 'prompts'), { recursive: true });
  await mkdir(join(skillRoot, 'data'), { recursive: true });

  const config = {
    version: 1,
    defaults: {
      mode: 'run',
      outputDir: './data',
      logLevel: 'info',
    },
    sources: {
      credentialFiles: {
        search: './search.json',
        openclaw: './openclaw.json',
      },
    },
    fetch: {
      activeProfile: 'grok-default',
      profiles: {
        'grok-default': {
          providerRef: 'grok',
          timeoutMs: 5000,
          retry: { maxAttempts: 1, backoffMs: 50 },
          concurrency: 1,
          batchSize: 2,
          timeWindowHours: 24,
          includeTweetTypes: ['original', 'repost', 'quote'],
          excludePureReplies: true,
          seedCsvPath: './seed.csv',
          promptFile: './assets/prompts/grok-fetch.txt',
        },
      },
    },
    analysis: {
      activeProfile: 'gpt-default',
      profiles: {
        'gpt-default': {
          providerRef: 'gpt',
          modelRef: 'gpt-main',
          apiProtocol: 'openai-compatible',
          timeoutMs: 5000,
          retry: { maxAttempts: 1, backoffMs: 50 },
          temperature: 0.2,
          maxOutputTokens: 500,
          promptFile: './assets/prompts/gpt-analyze.txt',
        },
        'claude-default': {
          providerRef: 'claude',
          modelRef: 'claude-main',
          apiProtocol: 'openai-compatible',
          timeoutMs: 5000,
          retry: { maxAttempts: 1, backoffMs: 50 },
          temperature: 0.2,
          maxOutputTokens: 500,
          promptFile: './assets/prompts/gpt-analyze.txt',
        },
      },
    },
    providers: {
      grok: {
        configSource: { fileRef: 'search', jsonPath: '$.grok' },
        mapping: { baseUrl: 'apiUrl', apiKey: 'apiKey', defaultModel: 'model' },
      },
      gpt: {
        configSource: { fileRef: 'openclaw', jsonPath: '$.models.providers.router-gpt' },
        mapping: { baseUrl: 'baseUrl', apiKey: 'apiKey', models: 'models' },
      },
      claude: {
        configSource: { fileRef: 'openclaw', jsonPath: '$.models.providers.anyrouter' },
        mapping: { baseUrl: 'baseUrl', apiKey: 'apiKey', models: 'models' },
      },
    },
    models: {
      'gpt-main': { providerRef: 'gpt', modelId: 'gpt-5.4(xhigh)' },
      'claude-main': { providerRef: 'claude', modelId: 'claude-sonnet-4-6' },
    },
    runtime: {
      pipeline: ['fetch', 'analyze'],
      artifacts: {
        fetchInput: 'fetch.input.json',
        fetchRaw: 'fetch.raw.json',
        fetchRawCsv: 'fetch.raw.csv',
        fetchResult: 'fetch.result.json',
        analyzeInput: 'analyze.input.json',
        analyzeResult: 'analyze.result.json',
        finalReport: 'final.md',
      },
    },
  };

  await writeFile(join(skillRoot, 'config.json'), JSON.stringify(config, null, 2));
  await writeFile(join(skillRoot, 'search.json'), JSON.stringify(FIXTURE_SEARCH, null, 2));
  await writeFile(join(skillRoot, 'openclaw.json'), JSON.stringify(FIXTURE_OPENCLAW, null, 2));
  await writeFile(join(skillRoot, 'seed.csv'), FIXTURE_SEED_CSV, 'utf8');
  await writeFile(
    join(skillRoot, 'assets', 'prompts', 'grok-fetch.txt'),
    'Fetch tweets for {{TIME_WINDOW_HOURS}} hours:\n{{SEED_BATCH_JSON}}',
    'utf8',
  );
  await writeFile(
    join(skillRoot, 'assets', 'prompts', 'grok-precheck.txt'),
    'Check last tweet date for {{SEED_COUNT}} accounts: {{HANDLE_LIST}}',
    'utf8',
  );
  await writeFile(
    join(skillRoot, 'assets', 'prompts', 'gpt-analyze.txt'),
    'Analyze tweets for {{REPORT_DATE}}:\n{{TWEET_EVIDENCE_BLOCK}}',
    'utf8',
  );

  return {
    root,
    skillRoot,
    configPath: join(skillRoot, 'config.json'),
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

export function createCompletionFetch(content) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  });
}

export function createCompletionFetchSequence(contents) {
  let index = 0;
  return async () => {
    const safeContents = Array.isArray(contents) && contents.length > 0 ? contents : [''];
    const content = safeContents[Math.min(index, safeContents.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
    };
  };
}

export function createCompletionFetchSequenceWithFinishReason(items) {
  let index = 0;
  return async () => {
    const safeItems = Array.isArray(items) && items.length > 0 ? items : [{ content: '', finishReason: 'stop' }];
    const item = safeItems[Math.min(index, safeItems.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: item.content }, finish_reason: item.finishReason }],
      }),
    };
  };
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function readText(filePath) {
  return readFile(filePath, 'utf8');
}
