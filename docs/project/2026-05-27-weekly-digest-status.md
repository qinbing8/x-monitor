# Weekly Digest Feature — Task Status

> Generated: 2026-05-27 | Phase: post spec-research, pre spec-plan

## 1. 目标 (Goal)

周日在 daily report `final.md` 末尾追加 `## 本周回顾` section，汇总过去 7 天高价值推文，按主题去重重组。

"过去 7 天" = 当天 Sunday daily（同一 run 中生成）+ R2 上前 6 天已发布的 `final.md`。覆盖周一到周日。

## 2. 关键约束 (Key Constraints)

1. **零新增输出文件** — weekly 内容写入 `final.md`，不产生独立 artifact；publish-report.mjs 与 Worker 不改
2. **Sunday-only** — 通过 `isWeeklyDigestDay(now, tz)` injectable clock 判定，TZ=Asia/Shanghai
3. **Section Alias Table 兼容多种 heading** — 主路径 (`## 今日亮点` / `## 高价值推文`) / fallback (`## 今日摘要` / `## 今日要点摘要` / `## 高价值推文完整清单`) / legacy schema
4. **去重策略** — 先按 `tweetId`/URL 全局去重，再 per-day 配额；禁止简单"截断最旧"
5. **Best-effort 三态** — 0 历史不追加 / 1–5 部分追加 + skipped 计数 / 6 完整覆盖
6. **markdownKey 安全** — 必须匹配 `reports/\d{4}-\d{2}-\d{2}/[^/]+/final\.md`，拒绝 `..` / 绝对路径 / 异常 scheme

## 3. 已完成 (Completed)

- 提案文档 `docs/project/2026-05-27-weekly-digest-proposal.md` 经 codex 多模型审查 (56/100 NEEDS_IMPROVEMENT) 后修订，Major×6 + Minor×3 + Suggestion×1 全部落地
- 新增 Section Alias Table、Best-effort Behavior Matrix、multi-runId 选择规则
- 配套测试改动随 commit `934262a` 已推送到 `origin/master`：rerun-configs 测试、live.acceptance 重构（roster 自动注入、放宽模型断言）
- 工作区已修订（未提交）：`docs/superpowers/plans/2026-04-13-fetch-smoke.md` heredoc/JSON 转义/openclaw.json 占位/阈值 2、`test/live.acceptance.test.mjs` answer.source 与 quality 断言矛盾解决 + provider 断言补回

## 4. 未完成 (Incomplete)

| 类型 | 项 | 阻塞依赖 |
|------|---|---------|
| 前置修复 | `references/output-schema.md` 与 `assets/prompts/gpt-analyze.txt` heading schema 收敛（独立小 PR） | 无，但是 weekly digest 的根因依赖 |
| 实现 | `scripts/select-weekly-sources.mjs` Node helper | schema 收敛后 |
| 实现 | `scripts/analyze.mjs` 增加 weekly digest 处理 + `weeklyDigest.sourceCount/skippedCount` 暴露 | helper 完成 |
| 实现 | `assets/prompts/gpt-weekly-digest.txt` prompt 模板 | 无 |
| 实现 | `.github/workflows/daily-report.yml` 条件下载步骤 | helper 完成 |
| 测试 | `test/analyze.weekly.test.mjs` (alias 抽取 / 去重 / 三态 best-effort / `isWeeklyDigestDay`) | 实现完成 |
| 测试 | `test/publish-report.weekly-strip.test.mjs` (`stripMaintenanceSections` 不删 weekly 内 blockquote) | 实现完成 |
| 待提交 | 工作区两文件 (fetch-smoke.md + live.acceptance.test.mjs) | 用户决定 |
| 待跑 | `/ccg:spec-plan` 生成零决策实施计划 | 上述前置修复 |

## 5. 关键文件 (Key Files)

**已存在 / 待修改**

- `docs/project/2026-05-27-weekly-digest-proposal.md` — 经审查修订的提案
- `docs/superpowers/plans/2026-04-13-fetch-smoke.md` — fetch-smoke 实施计划（已修订未提交）
- `scripts/analyze.mjs:1322,1337` — answerSource fallback 路径，weekly 调用点将插入 `finalizeAnalyzeRun()` 之后
- `scripts/publish-report.mjs:210-247` — `extractSummary()` 与 `stripMaintenanceSections()`，回归测试覆盖目标
- `assets/prompts/gpt-analyze.txt` — 主路径 prompt 模板，schema 收敛源头
- `references/output-schema.md:237-244` — 声明的 final.md schema，与 prompt 已漂移
- `.github/workflows/daily-report.yml:249-296` — R2 下载/上传步骤，weekly 条件步骤插入位置

**待新建**

- `scripts/select-weekly-sources.mjs` — 解析 index.json，按 date 分组 + multi-runId dedup + markdownKey 格式校验
- `assets/prompts/gpt-weekly-digest.txt` — weekly 总结 prompt
- `test/analyze.weekly.test.mjs`、`test/publish-report.weekly-strip.test.mjs`

## 6. 风险点 (Risks)

| 风险 | 影响 | 缓解 |
|------|------|------|
| **Schema 漂移** — 主路径 prompt (`## 今日亮点`) 与 output-schema.md (`## 今日要点摘要（Deep Brief）`) 不一致 | Section Alias Table 永远建在沙地上 | 优先开独立 PR 收敛后再实现 weekly |
| **`stripMaintenanceSections` noticePattern 误伤** — `publish-report.mjs:232` 含 `weekly`/`覆盖`/`周` 关键字 | weekly section 内 blockquote 被静默删除 | 进入 weekly section 后禁用 notice stripping，加回归测试 |
| **Token 预算偏倚** — 高价值推文集中某几天时简单截断会丢失早期内容 | 周报样本失衡 | 先全局 dedup → per-day proportional quota |
| **markdownKey 命令注入** — index.json 来源不可信值若直接进 shell `aws s3 cp` | 路径穿越 / 异常 R2 key 读取 | 严格正则校验 + execFile/argv 数组 |
| **多 runId 污染** — 同日多次手动 dispatch 会用尽 index.json 上限 60 | 历史日期被挤掉 | 按 date 分组，取 latest `updatedAt` with non-empty `markdownKey` |
| **Gemini API key 缺失** — 当前环境前端模型审查持续失败 | review 只能单模型，UX 视角缺失 | 配置 `GEMINI_API_KEY` 后补跑 `/ccg:review` |

## 下一步 (Next Step)

1. 用户决定是否提交工作区当前两文件
2. 开 schema 收敛 PR（output-schema.md ↔ gpt-analyze.txt 标题统一）
3. 收敛完成后跑 `/ccg:spec-plan` 生成实施计划
4. 实施 → `/ccg:review` 双模型审查（含前端 UX）→ 合并
