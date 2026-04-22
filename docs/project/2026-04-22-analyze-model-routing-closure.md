# x-monitor Analyze 阶段模型路由与终稿失败闭环

## 1. 目标

- 解释“终稿模型请求失败”为何反复出现。
- 确认问题是在 Cloudflare/Worker 侧，还是上游模型网关侧。
- 将 `modelId` 与 `reasoningEffort` 拆开，避免再使用 `gpt-5.4-xhigh` 这类混合写法。
- 让 `analyze` 阶段按不同场景使用不同模型，并给出 GitHub Actions `Repository Secrets` 的配置策略。
- 用测试、冒烟请求和日志证据形成验证闭环。

## 2. 结论

- 根因不在 Cloudflare Worker，本轮证据更指向上游 OpenAI-compatible 路由对模型名的识别与负载状态。
- `xhigh` 不是模型名，而是请求体里的推理强度；模型应写成 `gpt-5.4`，推理强度单独写成 `reasoning.effort = xhigh`。
- `analyze` 已支持按阶段切模：
  - 主终稿：`modelRef`
  - 终稿 fallback：`briefFallbackModelRef`
  - 预筛：`screeningModelRef`
  - roster 打分：`rosterModelRef`
- GitHub Actions 当前运行时映射为：
  - `OPENAI_BRIEF_MODEL` -> `gpt-brief`
  - `OPENAI_SCREENING_MODEL` -> `gpt-screening`
  - `OPENAI_ROSTER_MODEL` -> `gpt-roster`
- 当前 workflow 中，终稿 fallback 复用 `gpt-screening`，尚未拆成单独 secret。

## 3. 问题现象

- 用户侧现象：终稿多次失败，但任务并不总是红灯，系统会回退到可读的 fallback brief。
- 本地日志证据：
  - `logs/2026-04-22-2203.log` 中已出现“终稿模型请求失败，以下内容基于已完成的抓取、筛选与摘要结果自动整理”。
- 本次会话早先检查的 GitHub Actions `daily-report` 运行记录显示：
  - 抓取阶段出现较多 `403/429`
  - 主终稿请求曾出现 `502 unknown provider for model ...`
  - 后续 fallback brief 还出现过 overload 类错误
  - workflow 最终仍产出 fallback 报告并保持绿色

## 4. 方案设计

### 4.1 统一模型写法

- 禁止继续把推理强度拼进模型名，如：
  - `gpt-5.4-xhigh`
  - `gpt-5.4(xhigh)`
  - `gpt-5.4-high`
- 统一写法改为：
  - `modelId: gpt-5.4`
  - `reasoningEffort: xhigh`

### 4.2 Analyze 分阶段路由

- 解析 profile 时，从模型定义中取 `modelId` 与 `reasoningEffort`。
- 当某阶段配置了独立 `modelRef` 时，使用阶段专属 profile，不继承主终稿模型的推理强度。
- 这样可以做到：
  - 主终稿使用高推理
  - fallback 使用更稳或更便宜的模型
  - screening 和 roster 走独立模型

### 4.3 GitHub Actions 运行时注入

- workflow 在运行时基于 secrets 生成 `gpt-brief / gpt-screening / gpt-roster` 三个模型定义。
- `gpt-brief` 固定带 `reasoningEffort: xhigh`。
- 为兼容旧 secret 值，workflow 会把 `gpt-5.4-xhigh`、`gpt-5.4(xhigh)`、`gpt-5.4-high` 归一化成 `gpt-5.4`。

## 5. 已落地改动

- `scripts/openai-compatible-client.mjs`
  - `openai-responses` 请求体支持发送 `reasoning: { effort }`
- `scripts/provider-resolver.mjs`
  - 解析 analysis profile 时带出 `reasoningEffort`
- `scripts/analyze.mjs`
  - 支持按阶段切换 `brief / fallback / screening / roster` 模型
  - 终稿、筛选、摘要等请求显式透传 `reasoningEffort`
  - fallback 逻辑修正为：即使与主模型同名，也允许独立 fallback
  - 阶段 override 不再错误继承主 profile 的 `xhigh`
- `scripts/roster.mjs`
  - 透传 `reasoningEffort`
- `config.json`
  - `gpt-main.modelId = gpt-5.4`
  - `gpt-main.reasoningEffort = xhigh`
- `config.example.json`
  - 示例配置同步为新写法
- `.github/workflows/daily-report.yml`
  - 基于 secrets 生成分阶段运行时模型
  - 兼容旧 `OPENAI_BRIEF_MODEL` 值并归一化
- `部署教程.md`
  - 部署说明改为推荐 `OPENAI_BRIEF_MODEL = gpt-5.4`

## 6. 当前模型路由

### 6.1 仓库内默认配置

- `config.json`
  - `gpt-main = gpt-5.4 + xhigh`
  - `gpt-main-mini = gpt-5.4`
  - `gpt-default.modelRef = gpt-main`
  - `gpt-default.rosterModelRef = gpt-main-mini`
  - `gpt-default.screeningModelRef = gpt-main-mini`

### 6.2 GitHub Actions 运行时配置

- `OPENAI_BRIEF_MODEL` -> `gpt-brief`
  - `modelId = 归一化后的 OPENAI_BRIEF_MODEL`
  - `reasoningEffort = xhigh`
- `OPENAI_SCREENING_MODEL` -> `gpt-screening`
- `OPENAI_ROSTER_MODEL` -> `gpt-roster`
- `gpt-default` 运行时映射为：
  - `modelRef = gpt-brief`
  - `briefFallbackModelRef = gpt-screening`
  - `screeningModelRef = gpt-screening`
  - `rosterModelRef = gpt-roster`

## 7. Repository Secrets 建议

### 7.1 推荐立即调整

- `OPENAI_BRIEF_MODEL = gpt-5.4`
- `OPENAI_SCREENING_MODEL = gpt-5.4` 或你希望给筛选/终稿 fallback 用的其他模型
- `OPENAI_ROSTER_MODEL = gpt-5.4` 或你希望给打分用的其他模型

### 7.2 不需要新增的 secret

- 不需要新增 `OPENAI_REASONING_EFFORT`
- 不需要再把 `xhigh` 拼进模型名

### 7.3 兼容说明

- 如果线上现在还是旧值，如 `gpt-5.4-xhigh`，短期不会立刻失效，因为 workflow 已做归一化。
- 但为了配置清晰与后续排障，仍建议把 `OPENAI_BRIEF_MODEL` 改成纯 `gpt-5.4`。

### 7.4 如果要让 fallback 独立于 screening

- 需要新增单独 secret，例如 `OPENAI_BRIEF_FALLBACK_MODEL`
- 并修改 workflow，把 `briefFallbackModelRef` 指向独立的运行时模型定义

## 8. 验证闭环

### 8.1 Fresh smoke

- 时间：2026-04-22
- 目标：验证上游 `responses` 路由是否接受 `gpt-5.4 + xhigh`
- 请求：
  - `POST https://cpa.bbq13560.dpdns.org/v1/responses`
  - `model = gpt-5.4`
  - `reasoning.effort = xhigh`
- 结果：
  - HTTP `200`
  - 返回体最终回答包含 `OK`
- 结论：
  - 当前这条真实路由接受“模型名与推理强度分离”的新写法

### 8.2 本地回归测试

- 命令：
  - `node --test test/openai-compatible-client.test.mjs test/provider-resolver.test.mjs test/analyze.run.test.mjs`
- 结果：
  - `tests 28`
  - `pass 28`
  - `fail 0`
- 结论：
  - 请求构造、provider/profile 解析、analyze 阶段切模与 fallback 行为在本地回归测试中通过

### 8.3 证据与结论对应关系

- 结论：上游路由接受 `gpt-5.4 + xhigh`
  - 证据：fresh smoke 返回 `200` 且回答 `OK`
- 结论：代码已经支持分阶段切模
  - 证据：`scripts/analyze.mjs`、`scripts/provider-resolver.mjs`、`.github/workflows/daily-report.yml`
- 结论：新写法不会破坏现有关键行为
  - 证据：本地 `28/28 pass`
- 结论：线上旧 secret 值短期可兼容
  - 证据：workflow 对 `OPENAI_BRIEF_MODEL` 的归一化逻辑已落地

## 9. 进度

- 已完成：
  - 根因方向确认
  - 新模型写法冒烟验证
  - analyze 分阶段模型路由改造
  - workflow secret 注入与兼容旧值
  - 相关测试补齐并通过
  - 部署文档同步
- 待完成：
  - GitHub Repository Secrets 按推荐值清理
  - 如需 fallback 与 screening 分离，新增独立 secret 和 workflow 映射
  - 用最新 secrets 触发一次线上 `daily-report`，确认完整链路稳定

## 10. 后续操作建议

1. 先把 `OPENAI_BRIEF_MODEL` 明确改成 `gpt-5.4`。
2. 再决定 `OPENAI_SCREENING_MODEL` 和 `OPENAI_ROSTER_MODEL` 是否需要与主终稿模型区分。
3. 改完 secrets 后触发一次真实 `daily-report`，重点看：
   - 终稿是否仍报 provider/model 错误
   - fallback 是否不再被错误触发
   - 在抓取侧 `403/429` 存在时，终稿是否仍能稳定产出

## 11. 关键引用文件

- `.github/workflows/daily-report.yml`
- `config.json`
- `config.example.json`
- `scripts/analyze.mjs`
- `scripts/openai-compatible-client.mjs`
- `scripts/provider-resolver.mjs`
- `scripts/roster.mjs`
- `test/openai-compatible-client.test.mjs`
- `test/provider-resolver.test.mjs`
- `test/analyze.run.test.mjs`
- `logs/2026-04-22-2203.log`
