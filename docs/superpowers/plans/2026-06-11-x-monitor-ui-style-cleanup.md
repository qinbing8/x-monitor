# x-monitor UI Style Cleanup Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Status 2026-06-14:** This file was reconciled with the current workspace after the code/test contract had already moved to `## 今日亮点`. Use it as a verification/closeout checklist first. Only apply edit steps when the referenced old contract is actually present on the branch being worked.

**Goal:** Make generated x-monitor daily reports match the reference PDF style: content-first, clean Markdown, no prominent `@username` display, `## 今日亮点` as the summary heading, and compact interaction metrics.

**Architecture:** Keep fetch, ranking, screening, and scoring behavior unchanged. Limit changes to the report presentation contract: final-draft prompt, structured fallback Markdown, publish summary extraction, historical heading aliases, and regression tests.

**Tech Stack:** Node.js ESM, `node:test`, Markdown report generation in `scripts/analyze.mjs`, HTML publishing in `scripts/publish-report.mjs`.

---

## Context

Reference PDF: `linux.do人工智能技术日报-26-06-07 .pdf`

Current sample to compare: `data/2026-03-26/run-052454/final.md`

Observed reference style:

- The first summary section is `## 今日亮点`.
- The report leads with events, products, tools, and technical conclusions, not account handles.
- Source links and interaction metrics are lightweight metadata at the end of each item.
- Interaction metrics use the compact pattern `| 浏览 XXX · 点赞 XX · 回复 XX`.

Original issues this plan covers:

- Existing sample contains many prominent `@username` references in bullets, tables, editor picks, and coverage diagnostics.
- Older branches may use mixed headings: `## 今日亮点` in some output paths while tests/downstream extraction still reference `今日要点摘要`.
- Older branches may build fallback headlines from top handles, for example `@alice 重点更新`.
- Older branches may have `publish-report.mjs` summary extraction that only recognizes `## 今日要点摘要`.

Current workspace check on 2026-06-14:

- `test/analyze.run.test.mjs`, `assets/prompts/gpt-analyze.txt`, `scripts/analyze.mjs`, `scripts/publish-report.mjs`, `test/publish-report.test.mjs`, and weekly alias docs already contain the new `## 今日亮点` contract.
- The local PDF reference is not required to execute this plan; the style evidence needed for implementation is captured in the bullets above.

## File Map

- `assets/prompts/gpt-analyze.txt`: final model output contract. It should tell the model to write content-first Markdown and avoid `@username`-first phrasing.
- `scripts/analyze.mjs`: structured fallback report generation, local digest summary fallback, interaction metric line formatting, weak-brief detection.
- `scripts/publish-report.mjs`: HTML rendering and index summary extraction. It must recognize the new `## 今日亮点` heading.
- `test/analyze.run.test.mjs`: regression coverage for fallback final report Markdown.
- `test/publish-report.test.mjs`: regression coverage for rendering and summary extraction.
- `test/acceptance.contract.test.mjs`: prompt contract checks, if the existing prompt assertions are located there.
- `docs/project/2026-05-27-weekly-digest-proposal.md`: historical heading alias documentation.
- `docs/project/2026-05-27-weekly-digest-status.md`: current weekly-digest status notes that mention heading aliases.

## Task 1: Lock the New Fallback Markdown Contract

**Files:**

- Modify: `test/analyze.run.test.mjs`
- Modify: `scripts/analyze.mjs`

- [ ] **Step 1: Inspect current fallback tests**

Run:

```powershell
rg -n "今日要点摘要|今日亮点|高价值推文完整清单|编辑精选" test/analyze.run.test.mjs scripts/analyze.mjs
```

Expected on older branches: existing tests may still contain assertions for `今日要点摘要`, while `scripts/analyze.mjs` already contains some `今日亮点` fallback headings. If the current branch already asserts `## 今日亮点`, treat this step as verified.

- [ ] **Step 2: Update the structured fallback test to assert the new heading**

In the test named `runAnalyze writes a readable structured fallback brief when the GPT brief is empty`, replace old summary-heading assertions with:

```js
assert.match(analyzeResult.answer.markdown, /## 今日亮点/);
assert.doesNotMatch(analyzeResult.answer.markdown, /## 今日要点摘要/);
assert.match(analyzeResult.answer.markdown, /高价值推文完整清单/);
```

Keep the existing URL and `编辑精选` assertions.

- [ ] **Step 3: Add fallback handle-prominence assertions**

In the same test, after reading `finalReport`, add:

```js
assert.doesNotMatch(finalReport, /^-\s+@[\w_]{1,15}\b/m);
assert.doesNotMatch(finalReport, /\*\*@[\w_]{1,15}\*\*/);
assert.doesNotMatch(finalReport, /作者：@[\w_]{1,15}/);
assert.doesNotMatch(finalReport, /来源：@[\w_]{1,15}/);
```

Expected behavior: fallback content may still include X URLs, but visible bullets should not start with handles and should not format handles as the main subject.

- [ ] **Step 4: Update weak-brief fallback assertions**

In `runAnalyze falls back when the GPT brief is structurally weak despite being non-empty`, replace old heading assertions with:

```js
assert.match(analyzeResult.answer.markdown, /## 今日亮点/);
assert.doesNotMatch(analyzeResult.answer.markdown, /## 今日要点摘要/);
assert.match(analyzeResult.answer.markdown, /编辑精选/);
assert.match(analyzeResult.answer.markdown, /高价值推文完整清单/);
```

- [ ] **Step 5: Update request-failure fallback assertions**

In `runAnalyze preserves a final-draft diagnostic artifact and falls back to a readable brief when the request fails`, replace:

```js
assert.match(analyzeResult.answer.markdown, /今日要点摘要/);
```

with:

```js
assert.match(analyzeResult.answer.markdown, /## 今日亮点/);
assert.doesNotMatch(analyzeResult.answer.markdown, /## 今日要点摘要/);
```

- [ ] **Step 6: Run the focused failing test**

Run:

```powershell
node --test test/analyze.run.test.mjs
```

Expected on older branches before implementation: tests may fail because `buildLocalDigestSummaryEntries()` can still produce handle-first fallback headlines or because some old assertions remain. If the current branch already uses content-first headlines, continue to verification.

- [ ] **Step 7: Remove handle-derived fallback headlines**

In `scripts/analyze.mjs`, update `buildLocalDigestSummaryEntries(items, chunkIndex)`.

Replace this handle-first headline construction:

```js
const topHandles = handles.slice(0, 2).map((handle) => `@${handle}`);
const headlineBase = topHandles.length === 0
  ? `第 ${chunkIndex + 1} 组重点更新`
  : topHandles.length === 1
    ? `${topHandles[0]} 重点更新`
    : handles.length > 2
      ? `${topHandles.join(' / ')} 等重点更新`
      : `${topHandles.join(' / ')} 重点更新`;
const summaryParts = rankedItems
  .slice(0, 2)
  .map((item) => compactTweetText(String(item?.text ?? '').replace(/https?:\/\/\S+/gi, '').trim(), 72))
  .filter(Boolean);
```

with content-first headline construction:

```js
const summaryParts = rankedItems
  .slice(0, 2)
  .map((item) => compactTweetText(String(item?.text ?? '').replace(/https?:\/\/\S+/gi, '').trim(), 72))
  .filter(Boolean);
const headlineBase = summaryParts[0]
  ? compactTweetText(summaryParts[0], MAX_DIGEST_SUMMARY_HEADLINE_CHARS)
  : `第 ${chunkIndex + 1} 组重点更新`;
```

Keep `handles` in the returned structured data for auditability; only remove handles from display headlines.

- [ ] **Step 8: Run focused tests again**

Run:

```powershell
node --test test/analyze.run.test.mjs
```

Expected: analyze run tests pass, or failures are limited to unrelated pre-existing changes.

## Task 2: Strengthen the Final-Draft Prompt Contract

**Files:**

- Modify: `assets/prompts/gpt-analyze.txt`
- Modify: `test/acceptance.contract.test.mjs` if it validates prompt text

- [ ] **Step 1: Inspect prompt contract tests**

Run:

```powershell
rg -n "gpt-analyze|今日亮点|@用户名|候选高价值推文|低信噪比" test assets/prompts/gpt-analyze.txt
```

Expected on older branches: prompt may already contain `## 今日亮点` and a basic `不要在开头标注 @用户名` instruction. If the prompt already contains the explicit forbidden patterns below, treat this task as verified.

- [ ] **Step 2: Add explicit forbidden output patterns to the prompt**

In `assets/prompts/gpt-analyze.txt`, under `## 输出要求`, add or refine bullets so the contract says:

```markdown
- 内容优先，不要把账号当成条目的主语；禁止使用 `作者：@xxx`、`来源：@xxx`、`- @xxx ...`、`**@xxx**：...` 这类账号突出格式
- 必要时可以自然描述来源身份，例如“OpenAI 官方确认...”“Anthropic 研究团队发布...”“某开发者开源...”
- 不要输出以账号为主的来源表格；如果需要资源汇总，来源应写成内容型来源，例如“GitHub README”“官方公告”“原帖”
```

- [ ] **Step 3: Keep the compact metric example**

Ensure the prompt still contains this exact style:

```markdown
- 示例：`- OpenAI 确认封号为系统 Bug，赔偿一个月订阅 https://x.com/... | 浏览 931 · 点赞 13 · 回复 9`
```

- [ ] **Step 4: Update prompt contract tests if present**

If `test/acceptance.contract.test.mjs` asserts prompt content, add assertions equivalent to:

```js
assert.match(analyzePrompt, /## 今日亮点/);
assert.match(analyzePrompt, /禁止使用 `作者：@xxx`/);
assert.match(analyzePrompt, /浏览 931 · 点赞 13 · 回复 9/);
```

- [ ] **Step 5: Run prompt contract tests**

Run:

```powershell
node --test test/acceptance.contract.test.mjs
```

Expected: prompt contract tests pass.

## Task 3: Make Publish Summary Extraction Recognize `今日亮点`

**Files:**

- Modify: `scripts/publish-report.mjs`
- Modify: `test/publish-report.test.mjs`

- [ ] **Step 1: Add a failing summary extraction regression test through `publishRunArtifacts`**

In `test/publish-report.test.mjs`, add a test that writes a `final.md` with `## 今日亮点`, publishes it, and verifies the generated index summary uses the first bullet from `今日亮点`.

Use this test shape:

```js
test('publishRunArtifacts extracts index summary from 今日亮点', async () => {
  const root = await mkdtemp(join(tmpdir(), 'x-monitor-publish-summary-'));
  const runDir = resolve(root, 'data', '2026-06-11', 'run-080000-abcdef12');
  const outputDir = resolve(root, '.tmp', 'published');
  const summaryPath = resolve(root, '.tmp', 'run-summary.json');
  const previousIndexPath = resolve(root, '.tmp', 'previous-index.json');

  await mkdir(runDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(runDir, 'final.md'), [
    '# X 日报 | 2026-06-11',
    '',
    '> Low-coverage digest: partial evidence.',
    '',
    '## 今日亮点',
    '- OpenAI 确认封号为系统 Bug，赔偿一个月订阅。',
    '',
    '## 高价值推文',
    '- OpenAI 确认封号为系统 Bug https://x.com/openai/status/190001 | 浏览 931 · 点赞 13 · 回复 9',
  ].join('\n'), 'utf8');
  await writeFile(resolve(runDir, 'analyze.result.json'), JSON.stringify({
    meta: { analyzedAt: '2026-06-11T08:10:00.000Z' },
    quality: { needsReview: true, status: 'degraded', note: 'partial evidence' },
  }, null, 2), 'utf8');
  await writeFile(summaryPath, JSON.stringify({
    runDate: '2026-06-11',
    runId: 'run-080000-abcdef12',
    runDir,
    finalReportPath: resolve(runDir, 'final.md'),
    analyzeResultPath: resolve(runDir, 'analyze.result.json'),
  }, null, 2), 'utf8');
  await writeFile(previousIndexPath, '[]', 'utf8');

  await publishRunArtifacts({
    summaryPath,
    outputDir,
    previousIndexPath,
    siteOrigin: 'https://example.com',
    publicBaseUrl: 'https://example.com/reports',
  });

  const indexJson = JSON.parse(await readFile(resolve(outputDir, 'index.json'), 'utf8'));
  assert.equal(indexJson[0].summary, 'OpenAI 确认封号为系统 Bug，赔偿一个月订阅。');
});
```

- [ ] **Step 2: Run the focused test**

Run:

```powershell
node --test test/publish-report.test.mjs
```

Expected on older branches before implementation: the new test fails or summary is extracted from the fallback non-content line. If `extractSummary()` already recognizes `今日亮点`, continue to verification.

- [ ] **Step 3: Update `extractSummary()` heading aliases**

In `scripts/publish-report.mjs`, update:

```js
if (/^##\s+今日要点摘要/.test(trimmed)) {
  inDeepBrief = true;
  continue;
}
```

to:

```js
if (/^##\s+(?:今日亮点|今日摘要|今日要点摘要)(?:\s|（|\(|$)/.test(trimmed)) {
  inDeepBrief = true;
  continue;
}
```

- [ ] **Step 4: Avoid using blockquote notices as fallback summary**

In the fallback-line selection inside `extractSummary()`, make sure blockquotes are skipped:

```js
const fallbackLine = lines
  .map((line) => line.trim())
  .find((line) => line
    && !/^#+\s+/.test(line)
    && !/^>\s+/.test(line)
    && !/^-\s*$/.test(line));
```

- [ ] **Step 5: Run publish tests again**

Run:

```powershell
node --test test/publish-report.test.mjs
```

Expected: publish tests pass.

## Task 4: Update Markdown Rendering Fixtures and Assertions

**Files:**

- Modify: `test/publish-report.test.mjs`
- Modify if needed: `support/fixtures.mjs`

- [ ] **Step 1: Inspect old rendering fixture usage**

Run:

```powershell
rg -n "FIXTURE_ANALYZE_MARKDOWN|今日要点摘要|<code>@alice|@bob 列表" test/publish-report.test.mjs support/fixtures.mjs
```

Expected on older branches: the render test may still check old `今日要点摘要（Deep Brief）` and `<code>@alice</code>`. If the current render test already uses `今日亮点`, treat this step as verified.

- [ ] **Step 2: Update the main render fixture or test input**

If `FIXTURE_ANALYZE_MARKDOWN` is the shared old-style fixture, update only the local render test input to avoid broad fixture churn:

```js
const markdown = [
  '# X 日报 | 2026-03-23',
  '',
  '## 今日亮点',
  '- Alice 发布新的 agent tracing CLI。',
  '',
  '## 高价值推文',
  '- Alice 发布新的 agent tracing CLI https://x.com/alice/status/190001 | 浏览 12000 · 点赞 340 · 回复 18',
  '- Bob 发布 benchmark notes https://x.com/bob/status/190002 | 浏览 48000 · 点赞 820 · 回复 64',
].join('\n');
```

Call `renderMarkdownDocument(markdown, { title: '日报页面' })`.

- [ ] **Step 3: Replace old render assertions**

Use assertions like:

```js
assert.match(html, /<h2 id="今日亮点">今日亮点<\/h2>/);
assert.doesNotMatch(html, /今日要点摘要/);
assert.doesNotMatch(html, /<code>@alice<\/code>/);
assert.equal((html.match(/class="source-link">查看原文/g) ?? []).length, 2);
```

- [ ] **Step 4: Keep link policy assertions**

Keep or add an explicit mixed-section link policy test:

```js
const html = renderMarkdownDocument([
  '# X 日报',
  '',
  '## 今日亮点',
  '- 摘要段落 https://x.com/alice/status/190101',
  '',
  '## 高价值推文',
  '- 高价值段落 https://x.com/bob/status/190102 | 浏览 100 · 点赞 2 · 回复 1',
].join('\n'));

assert.doesNotMatch(html, /https:\/\/x\.com\/alice\/status\/190101/);
assert.match(html, /<a href="https:\/\/x\.com\/bob\/status\/190102" class="source-link">查看原文<\/a>/);
```

- [ ] **Step 5: Run publish render tests**

Run:

```powershell
node --test test/publish-report.test.mjs
```

Expected: rendering tests pass and no longer require visible `@username` formatting.

## Task 5: Update Weekly and Historical Heading Alias Documentation

**Files:**

- Modify: `docs/project/2026-05-27-weekly-digest-proposal.md`
- Modify: `docs/project/2026-05-27-weekly-digest-status.md`
- Modify implementation/tests if weekly extraction code already exists

- [ ] **Step 1: Locate heading alias references**

Run:

```powershell
rg -n "Section Alias|今日摘要|今日要点摘要|今日亮点|High-value tweets|高价值推文" docs scripts test
```

Expected on older branches: weekly docs may still list `今日摘要` and `今日要点摘要` but not `今日亮点`. If the docs already list `今日亮点` first, treat this step as verified.

- [ ] **Step 2: Update `2026-05-27-weekly-digest-proposal.md` alias table**

Change the Daily summary row to include the new primary heading:

```markdown
| Daily summary | `## 今日亮点` | `## 今日摘要` | `## 今日要点摘要` | `## 今日要点摘要（Deep Brief）` |
```

Keep the high-value row compatible:

```markdown
| High-value tweets | `## 高价值推文` | `## 高价值推文完整清单` | `## 高价值推文完整清单` |
```

- [ ] **Step 3: Update `2026-05-27-weekly-digest-status.md` references**

Where the status note says primary path is `## 今日摘要`, update it to say:

```markdown
主路径 (`## 今日亮点` / `## 高价值推文`)
```

Keep old headings listed as legacy/fallback aliases.

- [ ] **Step 4: Update implementation alias table if present**

If `rg` finds an implemented weekly extractor, add `今日亮点` to its daily summary aliases before older headings.

Use this order:

```js
const dailySummaryHeadings = [
  '今日亮点',
  '今日摘要',
  '今日要点摘要',
  '今日要点摘要（Deep Brief）',
];
```

- [ ] **Step 5: Run relevant weekly tests if present**

Run whichever exists:

```powershell
node --test test/publish-report.weekly-strip.test.mjs
node --test test/weekly*.test.mjs
```

Expected: existing weekly tests pass, or absent files are skipped manually with a note in final verification.

## Task 6: Final Verification

**Files:**

- Verify only unless failures expose a missed contract update

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
node --test test/analyze.run.test.mjs test/publish-report.test.mjs test/acceptance.contract.test.mjs
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run full project tests**

Run:

```powershell
npm test
```

Expected: full suite passes. If unrelated existing failures appear, capture the failing test names and error snippets.

- [ ] **Step 3: Scan for old heading contract residue**

Run:

```powershell
rg -n "今日要点摘要|今日摘要" scripts assets test docs
```

Expected: remaining matches are only legacy alias support, historical docs, or tests intentionally checking backward compatibility.

- [ ] **Step 4: Scan for prominent `@username` output patterns**

Run:

```powershell
rg -n "作者：@|来源：@|\\*\\*@|^- @|@用户名" scripts assets test docs
```

Expected: remaining matches are only negative tests, prompt forbidden examples, or internal parsing logic.

- [ ] **Step 5: Scan interaction metric examples**

Run:

```powershell
rg -n "浏览 .*点赞 .*回复|viewCount|likeCount|replyCount" scripts assets test
```

Expected: report-facing examples use `浏览 XXX · 点赞 XX · 回复 XX`; internal metric fields may remain English.

- [ ] **Step 6: Manual sample check**

Generate or inspect a local report artifact from the tests. Confirm:

- The first summary section is `## 今日亮点`.
- Bullets lead with content, not handles.
- High-value tweet rows end with `| 浏览 XXX · 点赞 XX · 回复 XX` when metrics exist.
- X links are compacted to `查看原文` in HTML for `## 高价值推文`.
- Maintenance diagnostics are not part of the public report body unless intentionally preserved as a top banner.

## Completion Criteria

- `scripts/analyze.mjs` no longer generates handle-first fallback headlines.
- `assets/prompts/gpt-analyze.txt` explicitly forbids prominent `@username` display patterns.
- `scripts/publish-report.mjs` extracts index summaries from `## 今日亮点`.
- Tests cover `## 今日亮点`, compact metrics, and no prominent handle display.
- Historical/weekly alias docs include `## 今日亮点` without dropping legacy compatibility.
- Targeted tests pass, and full `npm test` either passes or has documented unrelated failures.
