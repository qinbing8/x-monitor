# x-monitor 终稿 401 与模型名排查交接

> 生成于 2026-06-19。用途：clear 上下文后在新会话复制继续。本文件只保留当前判断和操作入口，避免保留旧会话的临时状态。

## 1. 当前结论

x-monitor 的终稿失败需要拆成两个问题看：

1. **请求模型名不对**：主终稿曾请求 `gpt-5.4`，但 new-api 实际可用主模型是 `gpt-5.5`。仓库配置和 GitHub Actions 运行时现在将主终稿模型指向 `gpt-5.5`，不要再把 `gpt-5.4` 当作主终稿模型排查。
2. **401 根因在外部 new-api 上游渠道**：run `27821437129` 里的请求到达 `new-api-613z.onrender.com` 的 `/v1/responses`，错误体是 `{"message":"Invalid API key","type":"bad_response_status_code"}`。这表示 x-monitor 到 new-api 的令牌通过了鉴权，401 来自 `new-api -> 上游渠道` 这一跳。

代码侧只能让降级/401 显式标红，不能修复上游渠道 key。真正修复入口在 new-api 后台。

## 2. 判别法

- `Invalid token` / `new_api_error`：new-api 自身令牌失效，检查 GitHub Secret `OPENAI_API_KEY` 或本地 `openclaw.json` 对应 token。
- `Invalid API key` / `bad_response_status_code`：new-api 令牌有效，上游渠道返回 401，检查 new-api 后台渠道 key、渠道分组、模型映射和 failover 设置。
- GitHub 日志里 model 可能显示 `***`，这是 secret masking，不代表模型为空；需要到 workflow 生成的运行时配置或 new-api 渠道模型配置里核对真实模型名。

## 3. 当前应核对的模型

- 主终稿：`gpt-5.5`
- 终稿 fallback / roster / screening：`gpt-5.4-mini`

new-api 后台要确认这两个模型名都有可用渠道承载。不要只检查 `gpt-5.4`，否则会继续误判。

## 4. new-api 后台处理入口

登录 `https://new-api-613z.onrender.com` 后台后优先检查：

1. 「渠道」里测试所有已启用渠道，定位返回 401 的上游渠道。
2. 更新失效渠道的上游 API key，或禁用坏渠道。
3. 确认渠道模型映射包含 `gpt-5.5` 和 `gpt-5.4-mini`。
4. 确认「系统设置 -> 重试次数」大于 0，否则坏渠道不会自动 failover。
5. 确认 token 分组和渠道分组匹配，避免 token 只能路由到失效渠道。
6. 查看 new-api「日志」里的错误/全部日志，或 Render 容器 stdout；上游 401 可能因退还预扣额度而不进入消费日志。

## 5. 仓库侧现状

- `config.json` / `config.example.json`：`gpt-main.modelId` 使用 `gpt-5.5`，`gpt-main-mini.modelId` 使用 `gpt-5.4-mini`。
- `.github/workflows/daily-report.yml`：GitHub Actions 运行时把空的或旧的 `OPENAI_BRIEF_MODEL=gpt-5.4*` 归一化为 `gpt-5.5`；末尾 `Flag degraded final draft` 会在终稿 401、本地结构化 fallback、fallback 模型出稿等降级场景标红。
- `scripts/analyze.mjs`：`runAnalyze` 返回 `answerSource`、`modelAvailabilityIssue`、`finalDraftDegraded`，供 workflow 门禁判断。
- `scripts/openai-compatible-client.mjs`：保留 `targetHost` / `targetPath` / retry / HTTP 错误诊断，用于区分请求是否到达 new-api。

## 6. 不要误判

- URL 当前不是主问题：`OPENAI_BASE_URL=https://new-api-613z.onrender.com/v1` 加 `api: "openai-responses"` 会请求 `/v1/responses`。
- 401 不是通过改 x-monitor 源码就能修复的错误；源码只能改变模型名、重试、降级告警和诊断输出。
- render 免费层如果使用容器内 SQLite，重部署可能丢渠道/令牌配置；需要确认 new-api 是否有持久化数据库。

## 新会话起始指令

```
继续 x-monitor 的终稿 401 / 模型名排查，工作目录 C:\Users\bing\.openclaw\workspace\skills\x-monitor。
先读 docs/project/2026-06-19-401-root-cause-handoff.md。

当前判断：
1. 主终稿模型应是 gpt-5.5，不要继续按 gpt-5.4 主模型排查。
2. bad_response_status_code + Invalid API key 表示请求已通过 new-api token 鉴权，401 来自 new-api 上游渠道。
3. 真正修复入口在 new-api 后台：渠道 key、模型映射、分组和 failover；仓库侧只负责显式告警和避免请求错误模型。
```
