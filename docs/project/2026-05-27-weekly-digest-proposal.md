# Weekly Digest on Sunday — Research Proposal

> Generated: 2026-05-27 | Phase: spec-research

## Goal

On Sundays, append a `## 本周回顾` section to the daily report (`final.md`), summarizing the past 7 days' high-value tweets deduplicated and regrouped by topic.

**Date window clarification**: "past 7 days" = Sunday's own daily content (generated in the same run) + the 6 preceding days' published reports fetched from R2. The weekly digest covers Monday through Sunday inclusive.

## Confirmed Decisions (User Input)

| # | Question | Decision |
|---|----------|----------|
| 1 | Content source | 7 published daily report markdowns from R2 |
| 2 | Output format | Single document — daily + weekly appended (not separate) |
| 3 | Reader | Owner only; concise and simple |
| 4 | Summarization style | Deduplicate 7 days' high-value tweets, regroup by topic |
| 5 | Cost tolerance | Acceptable for Sunday to cost more |
| 6 | Historical markdown retrieval | Modify `daily-report.yml` to pull past 6 days on Sunday |
| 7 | Timezone for "Sunday" | Asia/Shanghai (`TZ` already set in workflow) |
| 8 | Section placement | End of `final.md`: `## 本周回顾` (after daily content) |
| 9 | Prompt input scope | High-value tweets + daily summary sections from each historical report (see Section Alias Table) |
| 10 | Missing reports | Best-effort with three explicit states (see Best-effort Behavior Matrix) |

## Hard Constraints

1. **No new output files** — weekly content lives inside `final.md`, not a separate artifact.
2. **Sunday-only** — determined by `isWeeklyDigestDay(now, tz)` (injectable clock) under `TZ=Asia/Shanghai`.
3. **Data source is R2** — past 6 days' `final.md` fetched via `aws s3 cp` in the workflow step; Sunday's own daily content is read from the local run output.
4. **Section extraction via alias table** — extraction uses the Section Alias Table below; if neither alias matches for a given day, that day is logged as `skipped` (not silently dropped) and excluded from the weekly prompt input.
5. **Deduplication** — same tweet (by `tweetId` or URL) appearing across multiple days should appear only once in the weekly digest.
6. **Best-effort with three states** — see Best-effort Behavior Matrix below; never fail the pipeline.
7. **Publish pipeline unchanged** — `publish-report.mjs` and Worker need no modification; `## 本周回顾` is just markdown content that flows through existing rendering.
8. **`stripMaintenanceSections` must NOT strip the weekly section** — verify both the heading pattern regex AND the `maintenanceNoticePattern` do not match content inside `## 本周回顾`. The notice-level stripping must be disabled once inside the weekly section scope.
9. **Multi-runId resolution** — when multiple runs exist for the same date in `index.json`, select the entry with the latest `updatedAt` that has a non-empty `markdownKey`.
10. **markdownKey format validation** — only accept keys matching `reports/\d{4}-\d{2}-\d{2}/[^/]+/final\.md`; reject paths containing `..`, absolute prefixes, or unexpected schemes.

## Section Alias Table

The weekly extraction logic must recognize all known heading variants produced by the primary model path, the structured fallback path, and legacy reports:

| Semantic Role | Primary Path Heading | Compatibility Heading | Fallback Path Heading | Legacy/Schema Heading |
|---------------|----------------------|-----------------------|-----------------------|-----------------------|
| Daily summary | `## 今日亮点` | `## 今日摘要` | `## 今日要点摘要` | `## 今日要点摘要（Deep Brief）` |
| High-value tweets | `## 高价值推文` | `## 高价值推文完整清单` | `## 高价值推文完整清单` | `## 高价值推文完整清单` |

Extraction rule: for each historical report, try headings in order (primary → compatibility → fallback → legacy). Use the first match found. If no alias matches, mark that day as `skipped` in diagnostics.

## Best-effort Behavior Matrix

| Historical Sources Available | Behavior | Output |
|------------------------------|----------|--------|
| 0 reports (or all skipped) | Do not append weekly section | `final.md` contains daily content only; log `weeklyDigest.sourceCount=0` |
| 1–5 reports (partial) | Append weekly section with available data | Log `weeklyDigest.sourceCount=N, skippedCount=M` |
| 6 reports (full coverage) | Append weekly section normally | Log `weeklyDigest.sourceCount=6, skippedCount=0` |

## Soft Constraints

1. Weekly prompt should produce 5-10 topic groups, each with 2-4 representative tweets.
2. Keep weekly section under ~2KB markdown to maintain "concise" reading experience. (Note: 10 groups × 4 tweets × ~50 chars ≈ 2KB is feasible but tight; implementation may need to cap at 8 groups if links are preserved.)
3. Reuse existing `openai-compatible-client.mjs` and the same model/profile as the daily brief.
4. The weekly model call should use the same timeout and retry config as the daily final draft.
5. **Token budget strategy**: deduplicate by `tweetId`/URL first across all days, then apply per-day proportional quota before truncation. Do not simply truncate oldest days wholesale — this would systematically bias toward recent content.

## Dependencies

| Component | Dependency | Reason |
|-----------|-----------|--------|
| `daily-report.yml` | R2 bucket contains `reports/{date}/{runId}/final.md` | Source of historical markdowns |
| `analyze.mjs` | Workflow passes historical markdown paths | Analyze needs to know where to find them |
| Weekly prompt | Daily report section headings follow alias table | Extraction relies on alias-matched headings |
| `index.json` | Stores `markdownKey` for each run | Used to locate historical files in R2 |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| R2 download adds ~10s to Sunday runs | Low | Only 6 small files; parallel download possible |
| Historical report heading variants (primary vs fallback vs legacy) | Silent data loss in weekly digest | Section Alias Table covers all three known variants; unmatched days enter diagnostics as `skipped` |
| Token budget overflow (7 × extracted sections) | Model truncation / biased toward recent days | Deduplicate by `tweetId`/URL globally first, then per-day proportional quota; never truncate whole days wholesale |
| `index.json` doesn't store `markdownKey` for old entries | Can't locate files | `index.json` already stores `markdownKey` since inception |
| Same date has multiple `runId` entries in `index.json` | Wrong/stale run selected | Group by `date`, pick latest `updatedAt` with non-empty `markdownKey` |
| `maintenanceNoticePattern` in `publish-report.mjs:232` matches `weekly`/`覆盖`/`周` keywords | Weekly section blockquotes silently stripped | Test fixture covering `## 本周回顾` blockquotes; disable notice stripping once inside weekly section scope |
| Untrusted `markdownKey` value in shell command construction | Path traversal / arbitrary R2 key read | Validate against `reports/\d{4}-\d{2}-\d{2}/[^/]+/final\.md`; use `execFile` or argv array, not string interpolation |
| Direct `new Date().getDay()` calls inside `analyze.mjs` | Unit tests flaky depending on runtime TZ/date | Wrap in `isWeeklyDigestDay(now, tz)` helper; tests inject fixed timestamps |

## Success Criteria (Verifiable)

1. On a Sunday run, `final.md` contains both a daily summary section (any alias from the Section Alias Table) AND `## 本周回顾` (weekly).
2. On a non-Sunday run, `final.md` does NOT contain `## 本周回顾`.
3. Weekly section contains deduplicated tweets grouped by topic, with original links preserved.
4. If 0 historical reports are available on Sunday, the daily report still publishes successfully (no weekly section appended); `weeklyDigest.sourceCount=0` is logged.
5. `stripMaintenanceSections()` does not remove `## 本周回顾` or any blockquote content within it.
6. Worker `/history` page renders Sunday reports normally (no layout breakage).
7. `extractSummary()` still returns the daily summary (matches `## 今日亮点`, `## 今日摘要`, or `## 今日要点摘要` via its existing regex), not weekly content.
8. `isWeeklyDigestDay()` is testable with injected timestamps; tests cover Sunday, non-Sunday, and Asia/Shanghai midnight boundary.
9. `weeklyDigest.sourceCount` and `weeklyDigest.skippedCount` are exposed in `analyze.result.json` or maintenance diagnostics.

## Affected Files (Estimated)

| File | Change Type | Description |
|------|-------------|-------------|
| `.github/workflows/daily-report.yml` | Modify | Add conditional step: call helper to resolve weekly source keys, then `aws s3 cp` each |
| `scripts/analyze.mjs` | Modify | After daily brief generation, on Sunday, run weekly digest and append |
| `scripts/select-weekly-sources.mjs` | Create | Node helper: reads `index.json`, resolves past 6 days' `markdownKey` (multi-runId dedup, format validation), outputs download list |
| `assets/prompts/gpt-weekly-digest.txt` | Create | Weekly summarization prompt |
| `test/analyze.weekly.test.mjs` | Create | Unit tests for weekly digest logic (alias extraction, dedup, three-state best-effort) |
| `test/publish-report.weekly-strip.test.mjs` | Create | Regression test: `stripMaintenanceSections` preserves `## 本周回顾` content including blockquotes |

## Implementation Sketch (Non-Binding)

```
Workflow (Sunday only):
  → Detect Sunday via inline Node: isWeeklyDigestDay(new Date(), 'Asia/Shanghai')
  → Call: node scripts/select-weekly-sources.mjs --index .tmp/github-actions/previous-index.json --days 6
    - Reads index.json, groups by date, picks latest updatedAt per date
    - Validates markdownKey format (rejects .., absolute paths)
    - Outputs JSON list of { date, markdownKey } to stdout
  → Shell loop: aws s3 cp each markdownKey to .tmp/github-actions/weekly-sources/{date}.md
  → Pass directory path to run.mjs via env WEEKLY_SOURCES_DIR

Analyze stage (Sunday only):
  → After finalizeAnalyzeRun() produces final.md
  → Detect Sunday via isWeeklyDigestDay(now, tz) (injectable clock)
  → Read historical markdowns from WEEKLY_SOURCES_DIR
  → Also read Sunday's own daily final.md (just generated)
  → For each source: extract sections using Section Alias Table (primary → fallback → legacy)
  → Deduplicate by tweetId/URL across all days
  → Apply per-day proportional quota if total exceeds ~8KB char budget
  → Build weekly prompt with extracted + deduped content
  → Call model (same profile as daily brief)
  → Append ## 本周回顾 to final.md
  → Log weeklyDigest.sourceCount / skippedCount to analyze result

No changes to:
  → publish-report.mjs (just processes final.md as-is)
  → worker/src/index.js (renders whatever HTML publish produces)
  → config.json (no new config keys needed, or optional)
```

## Next Step

Run `/ccg:spec-plan` to generate a zero-decision implementation plan from these constraints.
