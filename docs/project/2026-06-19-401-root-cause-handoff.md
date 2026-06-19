# x-monitor 终稿 401 排查 — 任务交接文档

> 生成于 2026-06-19。用途：clear 上下文后在新会话复制继续。本文件自包含，新会话无需旧上下文即可接手。

## 1. 目标
排查 x-monitor 反复出现的「终稿模型请求失败：401 Invalid API key，请检查模型可用性」（展示页 https://x.bbq08.ip-ddns.com/），找到**具体根因**；并按用户选择，在代码侧加「失败显式告警」（让 GitHub Actions run 在终稿 401/降级时标红，不再静默 success）。

## 2. 关键约束
- **根因在外部 new-api（render 部署），不在本仓库代码，也不在 GitHub Secrets。** 修复 401 必须在 new-api 后台操作，x-monitor 代码改不了。
- new-api 自身令牌**有效**；故障在 `new-api → 上游渠道` 这一跳。
- 中文交流；遵循 CCG 流程；**不主动 git commit**（需用户显式授权，可走 `/ccg:commit`）。
- 历史多次「修复」只改了报错展示/本地兜底，从未触及外部 new-api，所以反复复发——不要再往代码里找 401 根因。

## 3. 已完成
- **根因铁证定位**：今日 run `27821437129` 日志显示 `targetHost: new-api-613z.onrender.com`、`targetPath: /v1/responses`，错误体 `{"message":"Invalid API key","type":"bad_response_status_code"}`。`bad_response_status_code` 由 new-api `RelayErrorHandler` 在转发上游、上游返回非 2xx 时产生 → 证明请求已到 new-api、通过令牌鉴权、是**上游渠道**回的 401。
- **判别法**：`Invalid token`/`new_api_error` = new-api 自身令牌失效；`Invalid API key`/`bad_response_status_code` = 令牌有效、上游渠道失效。（实测假令牌得到前者，真实 run 得到后者。）
- **URL 确认正确**：`OPENAI_BASE_URL=https://new-api-613z.onrender.com/v1` + workflow 写死 `api: "openai-responses"` → 实际请求 `https://new-api-613z.onrender.com/v1/responses`。URL 没问题。
- **「无使用日志」解释**：上游 401 → new-api 退还预扣额度、无 token 消费 → 不进「消费日志」。痕迹要看 new-api「日志」切到错误/全部，或 Render 容器 stdout。
- **请求次数统计（run 27821437129）**：analyze 阶段 24 次全 401（roster 2 / screening 6 / digest 12 / 终稿 4），fetch（grok）117 次全成功——故障完全隔离在 new-api。重试 `maxAttempts=2`（每操作 1 次初试 + 1 次重试）；终稿主模型 2 次 + fallback 模型 2 次 = 4 次。
- **代码改动（失败显式告警，已过 51 项测试，未提交）**：
  - `scripts/analyze.mjs`：`runAnalyze` 返回值新增 `answerSource` / `modelAvailabilityIssue` / `finalDraftDegraded`。
  - `.github/workflows/daily-report.yml`：末尾新增门禁 step `Flag degraded final draft`（报告/状态照常发布后，401 或降级则 `::error::` + `exit 1`）。
  - `test/analyze.run.test.mjs`：健康 + 401 两路径断言。
  - 验证：`node --test test/analyze.run.test.mjs`（20）、`daily-report.workflow.test.mjs`（3）、`publish-report/analyze.core/acceptance.contract`（28）全绿；YAML 语法 OK；门禁四场景退出码正确。
- 已写 memory：`x-monitor-401-root-cause`。

## 4. 未完成
- **用户侧（修根因）**：登录 `https://new-api-613z.onrender.com` 后台 →「渠道」→「测试所有已启用渠道」定位失效渠道 → 更新上游 key；并核对：①承载 `gpt-5.4`/`gpt-5.4-mini` 的是哪些渠道 ②「系统设置→重试次数」是否>0（否则不 failover）③令牌分组 vs 渠道分组是否匹配。
- **查 new-api 令牌额度/用量**：已发起用本地 `openclaw.json` 的 `router-gpt` 令牌查 `/v1/dashboard/billing/{subscription,usage}` 的命令，结果未确认。
- **代码改动未提交**：clear 后先 `git status` / `git diff` 确认，再决定 `/ccg:commit`。
- 可选改进：调大 analyze `maxAttempts`；或把 `api` 从 `openai-responses` 改 `openai-completions` 验证是否端点协议相关（实测是 401 鉴权，非端点问题，优先级低）；启用 config 里已定义但 CI 未用的 `gpt-backup`/`claude` 备用 provider。

## 5. 关键文件
- `scripts/analyze.mjs` — 终稿主+备调用（~1295-1340）、401 判定 `detectFinalDraftModelAvailabilityIssue`（~1137）、`runAnalyze` 返回值（~1614，已改）、`analyze.error.json` 写入。
- `scripts/openai-compatible-client.mjs` — HTTP 请求、`withRetry`、`normalizeBaseUrl`、`resolveRequestUrl`（`/responses` vs `/chat/completions`）、`targetHost/targetPath` 诊断。
- `scripts/provider-resolver.mjs` — provider 字段映射。
- `config.json` / `config.example.json` — `providers.gpt` 映射：`baseUrl/apiKey ← openclaw.json $.models.providers.router-gpt`。
- `.github/workflows/daily-report.yml` — CI 注入 secret 生成 `openclaw.json`（~161-181，`baseUrl=OPENAI_BASE_URL`、`api: "openai-responses"`）；门禁 step（末尾，已加）。
- `.tmp/run-27821437129.log` — 今日失败 run 完整日志（诊断证据，.tmp 已被 gitignore）。
- 凭证：`C:/Users/bing/.openclaw/openclaw.json` 的 `router-gpt`（本地 token，可能与 CI secret 不同）。

## 6. 风险点
- **render 免费层 + 容器内 SQLite 无持久化** → 重部署丢渠道/令牌配置，是周期性复发的可能诱因；需确认是否挂外部持久化 DB。
- **多渠道常见坑**：正常渠道没配 `gpt-5.4`/`gpt-5.4-mini` 这两个确切模型名 → 路由轮不到它；或重试次数=0 不 failover；或令牌分组下只有失效渠道。
- 代码门禁**只标红不修复 401**（治标），真正修复在 new-api 后台。
- 日志里 model 显示 `***`（是 GitHub secret `OPENAI_BRIEF_MODEL` 等），需与 new-api 渠道里的模型名逐一对照。
- 代码改动**未提交**，clear 后状态需重新确认。

---

## 新会话起始指令（复制到新会话）

```
继续 x-monitor 的「终稿 401」任务，工作目录 C:\Users\bing\.openclaw\workspace\skills\x-monitor。
先读 docs/project/2026-06-19-401-root-cause-handoff.md 获取完整上下文，再 git status / git diff 确认未提交改动。

已确认根因：请求正确到达 new-api（targetHost=new-api-613z.onrender.com，URL 对）、通过令牌鉴权，
失败在 new-api→上游渠道（bad_response_status_code，上游回 401）。修复在 new-api 后台改渠道 key，
不在本仓库代码。不要重新从代码里找 401 根因。

代码侧「失败显式告警」已完成（analyze.mjs 返回值 + daily-report.yml 门禁 step + 测试），51 测试全绿，未提交。

接下来我需要你做：<在此填写，例如：提交这批改动 / 帮我对照模型名与 new-api 渠道 / 调大重试 / 查令牌额度>
```
