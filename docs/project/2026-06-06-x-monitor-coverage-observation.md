# X Monitor 覆盖观察记录

日期：2026-06-06

## 1. 目标

项目目标是抓取 X 关注列表的近期信息，形成可持续的日报信息流。当前优先级从“节省调用量”调整为“提高信息流覆盖面”，避免账号在抓取前被过早跳过。

## 2. 关键约束

- 远端日报由 GitHub Actions `daily-report` 执行，Cloudflare Worker 只负责读取 R2 并展示报告。
- Actions 从 `config.example.json` 生成运行配置；配置变更需要提交并推送后，下一次远端 Actions 才会生效。
- R2 会保存 `reports/latest.json`、`fetch.result.json`、`analyze.result.json`、`maintenance.json` 和状态文件，但不保存完整 `fetch.raw.json`、`analyze.input.json` 或完整 stdout/stderr。
- 当前不直接取消 roster 冷却，先观察关闭 precheck 后的覆盖变化。

## 3. 已完成

- 将默认 Grok fetch profile 的 `precheck.enabled` 设为 `false`。
- 将默认 Grok fetch profile 的 `precheck.staticFilterZeroPosts` 设为 `false`。
- 补充默认配置测试，确保默认行为不会在抓取前跳过 dormant/zero-post 账号。
- 更新 README，将 precheck 描述改为默认关闭、仅在需要节省调用量时手动启用。

## 4. 未完成

- 尚未取消 `roster.dormantCooldownDays`。
- 尚未把 roster 改成全量或近全量抓取。
- 尚未部署后观察新的 Actions 日报结果。
- 尚未补充 R2 端的完整 raw artifact 上传能力。

## 5. 关键文件

- `config.example.json`：远端 Actions 配置来源，决定 precheck 默认是否启用。
- `config.json`：本地运行配置，通常不提交。
- `.github/workflows/daily-report.yml`：生成远端运行配置、下载/上传 R2 状态和报告。
- `scripts/fetch.mjs`：执行 precheck、静态 zero-post 过滤、Grok 抓取和 fetch 结果生成。
- `scripts/roster.mjs`：每日 roster 选择、`nextEligibleAt` 冷却、账号打分和 tier cadence。
- `test/config-defaults.test.mjs`：锁定默认配置不在抓取前跳过账号。

## 6. 风险点

- 关闭 precheck 后，Grok 抓取请求量、运行时间和 token 消耗可能上升。
- `roster.dormantCooldownDays` 仍可能让被判 dormant 的账号在 7 天内不进入 daily roster。
- 账号 tier/cadence 仍会让 333 个关注账号只进入部分 daily roster；如果目标是完整信息流，这仍可能偏窄。
- 如果远端 R2 的 `account-score.json` 已积累较多 `nextEligibleAt`，短期内 coverage 仍可能被历史状态影响。
- Actions 日志只保留运行日志，R2 当前没有完整 raw artifact，后续深度诊断仍可能缺证据。
- 判断是否继续取消 cooldown，应至少观察部署后 1-2 次 Actions 的 `dailyCount`、`cooldownSkippedCount`、`activeSeedCount`、`coveredAccountCount`、`tweetCount` 和 `promptSignalTweetCount`。
