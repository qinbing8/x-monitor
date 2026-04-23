# x-monitor 终稿超时与 fallback 标记加固

## 1. 目标

- 将 analyze 阶段的终稿请求超时预算提升到 8 分钟，避免当前 300000ms 的固定客户端超时过早中断。
- 将 `OPENAI_BRIEF_FALLBACK_MODEL` 从 screening 模型中独立出来，形成单独的终稿 fallback 链路。
- 在 `analyze.result.json` 和最终日报中显式标记“本稿由 fallback 模型生成”，并附带主终稿失败摘要，方便排查上游问题。
- 记录每次终稿生成尝试的耗时与结果，形成后续决策依据。

## 2. 证据与判断

- `2026-04-23` 的 GitHub Actions `daily-report` run `24823871203` 显示，主终稿和 fallback 终稿都在 `300000ms` 后报 `Request timed out after 300000ms`。
- 仓库代码 `scripts/openai-compatible-client.mjs` 使用 `AbortController` 和 `timeoutMs` 主动中断请求；`scripts/analyze.mjs` 的分析阶段超时下限此前为 `300000ms`。
- 已查 Zeabur 官方站点公开资料与 docs，未找到“free 计划固定 300000ms 请求超时”的官方说明。
- 因此当前更合理的判断是：`300000ms` 主要来自客户端自己的超时预算，而不是已经证实的 Zeabur free 限制。

## 3. 方案

### 3.1 超时预算

- 将 analyze 阶段超时下限从 `300000ms` 提升到 `480000ms`。
- 同步更新仓库配置模板中的 `analysis.profiles.*.timeoutMs` 为 `480000ms`，让运行时配置和代码下限保持一致。

### 3.2 独立 fallback 模型

- GitHub Actions 新增 `OPENAI_BRIEF_FALLBACK_MODEL`。
- workflow 运行时生成 `gpt-brief-fallback` 模型定义。
- `gpt-default.briefFallbackModelRef` 改为 `gpt-brief-fallback`，不再复用 `gpt-screening`。
- fallback 模型默认 `modelId = gpt-5.4`，不设置 `reasoningEffort`。

### 3.3 可观测性

- `analyze.result.json` 新增：
  - `primaryBriefModel`
  - `briefFallbackModel`
  - `generatedByFallbackModel`
  - `primaryBriefFailure`
  - `primaryBriefFailureSummary`
  - `finalDraftAttempts[]`
- `finalDraftAttempts[]` 记录每次终稿尝试的：
  - `kind`
  - `model`
  - `reasoningEffort`
  - `status`
  - `durationMs`
  - `continuationRounds`
  - `truncated`
  - `error`
  - `errorSummary`
- 当主模型失败但 fallback 模型成功时，`final.md` 顶部插入提示：
  - `本稿由 fallback 模型生成。主终稿模型失败摘要：...`

## 4. 进度

- 已完成：
  - analyze 阶段 8 分钟超时预算
  - 终稿 fallback 独立模型接线
  - fallback 成功标记与失败摘要输出
  - 终稿尝试耗时记录
  - workflow / analyze / schema / 部署文档更新
  - 回归测试补齐
- 待观察：
  - 修改上线后继续观察 `daily-report` run 的主终稿是否仍出现上游超时或 overload
- 预备决策：
  - 若这轮修改后终稿上游仍持续失败，再把主终稿模型推理强度从 `xhigh` 调整为 `high`

## 5. 验证闭环

- 定向测试命令：
  - `node --test test/analyze.run.test.mjs test/daily-report.workflow.test.mjs`
- 重点验证点：
  - 仓库配置默认超时为 `480000ms`
  - workflow 已接入 `OPENAI_BRIEF_FALLBACK_MODEL`
  - 主终稿失败后 fallback 成功时，`analyze.result.json` 显式标记 `fallback_model`
  - `final.md` 显示 fallback 生成提示与主模型失败摘要
  - `finalDraftAttempts[]` 记录每次终稿尝试的耗时

## 6. 后续观察项

上线后重点看下一次 `daily-report`：

1. 主终稿是否仍在 `cpa.bbq13560.dpdns.org/v1/responses` 超时。
2. fallback 终稿是否能稳定生成正文。
3. `analyze.result.json` 中 `finalDraftAttempts[]` 的耗时分布是否明显接近 8 分钟上限。
4. 若主终稿仍长期逼近上限，再执行下一步：
   - 将主终稿 `reasoningEffort` 从 `xhigh` 调整为 `high`
