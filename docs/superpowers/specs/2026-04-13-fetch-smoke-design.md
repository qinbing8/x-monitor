# Fetch Smoke Design

## 目标

新增一个独立的 `fetch-smoke` GitHub Actions workflow，用最小成本验证真实 Grok 抓取链路，不再每次都跑完整 `daily-report`。

这个 workflow 的核心用途是快速判断：

- 本次运行实际使用的 `requestedModel` / `chosenModel`
- 问题更像是模型本身、Grok 网关 / 中转站，还是正式日报里的并发配置放大了问题
- 当前抓取链路是否存在明显的 `timeout` / `HTTP 500`

## 非目标

- 不运行 analyze、publish、deploy
- 不改动正式 `daily-report` workflow
- 不调整正式抓取参数、正式 seed 名单或正式持久化状态
- 不在这次设计里引入并发对比模式；本次只保留 serial 诊断

## 触发方式

新增 `.github/workflows/fetch-smoke.yml`，仅支持 `workflow_dispatch` 手动触发。

## 输入与环境

workflow 复用正式日报使用的同一组 Grok secrets：

- `GROK_API_KEY`
- `GROK_BASE_URL`
- `GROK_MODEL`

workflow 需要沿用 `daily-report` 中已有的运行时模型探测逻辑，生成：

- `requestedModel`
- `chosenModel`
- `availableModelCount`

## 执行流

### 1. 运行时模型探测

在 workflow 内先探测 `${GROK_BASE_URL}/models`，根据现有逻辑生成 `GROK_RUNTIME_MODEL`。

探测结果必须打印到日志，至少包含：

- `requestedModel`
- `chosenModel`
- `availableModelCount`

### 2. 生成临时 probe CSV

workflow 在临时目录生成一份只包含 3 个固定账号的 seed CSV。

要求：

- 不覆盖仓库根目录的正式 `X列表关注者.csv`
- 不依赖 R2 下载的正式状态文件
- 账号名单固定、可复现、便于长期对比 smoke 结果
- workflow 直接在临时目录内写入这 3 个固定账号，不额外引入新的持久化状态文件

### 3. 生成 fetch-smoke 临时配置

基于现有 `config.example.json` 生成一份临时 `config.fetch-smoke.generated.json`，仅覆盖 fetch 相关最小参数：

- `batchSize = 1`
- `concurrency = 1`
- `timeoutMs = 75000`
- `refetchMaxRounds = 0`
- `retry.maxAttempts = 1`
- 使用真实 Grok provider 与探测后的 `GROK_RUNTIME_MODEL`

运行命令固定为：

```bash
node scripts/run.mjs --mode fetch --config ./config.fetch-smoke.generated.json --seed-csv ./.tmp/github-actions/fetch-smoke.csv --skip-precheck
```

## 诊断输出

workflow 结束前必须打印一段机器可读的摘要 JSON，字段固定为：

- `requestedModel`
- `chosenModel`
- `baseUrlHost`
- `seedCount`
- `durationMs`
- `tweetCount`
- `coveredAccountCount`
- `warningCount`
- `timeoutCount`
- `http500Count`

这些统计应从 fetch 产物和 workflow 日志中汇总出来，而不是依赖人工阅读原始日志。

## Artifacts

workflow 需要上传 fetch 阶段原始产物，至少包括：

- `fetch.input.json`
- `fetch.raw.json`
- `fetch.result.json`
- `fetch.raw.csv`
- `fetch.tweet-index.csv`

这些 artifacts 仅用于诊断，不参与正式发布。

## 失败判定

为了避免 smoke “成功结束但没有诊断价值”，workflow 需要增加轻量失败门槛：

- `chosenModel` 为空时直接失败
- `timeoutCount + http500Count >= 3` 时失败
- `tweetCount = 0` 且 `coveredAccountCount = 0` 时失败

失败时仍应尽量保留 artifacts，方便后续回看。

## 测试策略

新增一个 workflow 级回归测试，锁住 smoke workflow 的关键约束，至少断言：

- 存在 `GROK_RUNTIME_MODEL` 探测步骤
- 只运行 `--mode fetch`
- 使用临时 probe CSV
- `concurrency = 1`
- `batchSize = 1`
- `refetchMaxRounds = 0`
- 不包含 analyze / publish / deploy 步骤

## 验收标准

- 手动触发 `fetch-smoke` 后，能在几分钟内给出诊断结论
- 日志里能直接看到 `requestedModel / chosenModel`
- 摘要 JSON 能直接显示 `timeoutCount` 与 `http500Count`
- workflow 不进入 analyze、publish、deploy
- workflow 回归测试可以稳定锁住关键行为

## 风险与权衡

- 3 个账号样本很小，适合快速诊断，不适合作为正式覆盖率评估
- serial smoke 只能回答“单请求链路是否稳定”，不能直接回答“并发 3 是否放大问题”
- 如果后续需要判断并发因素，应在这个 smoke 通过后再增加第二种并发模式，而不是在本次设计里混入
