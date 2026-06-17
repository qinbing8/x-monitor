# x-monitor

`x-monitor` 是一个面向 X/Twitter 账号名单的监控与日报流水线。
它从本地 CSV 名单出发，先用 Grok 抓取最近 24 小时推文，再用 GPT 或 Claude 做筛选、账号评分和日报生成。

这个仓库既可以作为 OpenClaw skill 使用，也可以直接在本地用 Node.js 脚本运行。

## 核心能力

- 用本地账号名单批量抓取最近 24 小时的推文
- 自动维护 `daily roster`，减少无效抓取
- 输出可审计的抓取原始结果、标准化结果和最终日报
- 支持本地执行、GitHub Actions 定时执行和 Cloudflare Worker 展示

当前默认职责边界：

- Grok：抓取和整理原始推文
- GPT / Claude：筛选价值内容、账号评分、生成日报
- roster：根据历史评分和抓取状态生成当天名单

当前默认 GPT 成本策略：

- 终稿主模型使用 `gpt-5.4`，推理强度为 `high`
- 终稿 fallback、中间筛选和账号评分默认使用 `gpt-5.4-mini`
- GitHub Actions 可通过 `OPENAI_BRIEF_MODEL`、`OPENAI_BRIEF_FALLBACK_MODEL`、`OPENAI_SCREENING_MODEL`、`OPENAI_ROSTER_MODEL` 覆盖默认模型

## 流程概览

完整运行一次 `run` 时，默认顺序如下：

1. 读取 `X列表关注者.csv`
2. 结合 `account-score.json` 生成 `X列表关注者.daily.csv`
3. 用 Grok 抓取 `daily.csv` 账号过去 24 小时内的推文
4. 用 GPT 或 Claude 对结果做筛选和整理
5. 将产物写入 `data/YYYY-MM-DD/run-*/`

常见核心文件：

- `X列表关注者.csv`
  全量主名单
- `X列表关注者.daily.csv`
  每日抓取名单，通常自动生成
- `account-score.json`
  历史评分、档位、上次抓取日期
- `config.json`
  本地运行配置

## 仓库结构

```text
x-monitor/
├─ assets/prompts/          # Grok / GPT 提示词
├─ docs/                    # 设计文档与计划
├─ references/              # 输出结构与需求说明
├─ scripts/                 # 主流程脚本
├─ support/                 # 测试辅助
├─ test/                    # 单元测试与验收测试
├─ worker/                  # Cloudflare Worker 站点
├─ config.example.json      # 配置模板
├─ SKILL.md                 # OpenClaw skill 说明
└─ 部署教程.md               # 云端部署说明
```

## 环境要求

- Node.js 22 或更高版本
- 一份可用的 X 账号名单 CSV
- 可访问的 Grok 接口
- 可访问的 OpenAI-compatible 分析接口

如果你要让 OpenClaw 自动识别这个 skill，推荐放在：

```text
~/.openclaw/workspace/skills/x-monitor
```

## 快速开始

### 1. 准备配置文件

从模板复制：

```powershell
Copy-Item .\config.example.json .\config.json
```

`config.json` 里不要写真实 API Key，只保留外部凭据文件路径。

推荐写法：

```json
{
  "sources": {
    "credentialFiles": {
      "search": "~/.openclaw/credentials/search.json",
      "openclaw": "~/.openclaw/openclaw.json"
    }
  }
}
```

默认约定：

- `search`
  指向 Grok 凭据 JSON
- `openclaw`
  指向 GPT / Claude 提供方配置 JSON

### 2. 准备名单文件

至少需要：

- `X列表关注者.csv`

可选但常用：

- `account-score.json`
- `X列表关注者.daily.csv`

如果你是首次运行，没有 `account-score.json` 也可以，程序会在运行后生成。

### 3. 执行完整流程

```powershell
node scripts/run.mjs --mode run
```

默认会先准备 roster，再抓取，再分析。

## 常用命令

### 完整流程

```powershell
node scripts/run.mjs --mode run
```

### 只抓取

```powershell
node scripts/run.mjs --mode fetch
```

### 只分析

前提是目标日期已有 `fetch.result.json`：

```powershell
node scripts/run.mjs --mode analyze
```

### 指定运行日期

```powershell
node scripts/run.mjs --mode run --date 2026-03-27
```

说明：

- `--date` 控制产物目录和分析读取日期
- 抓取窗口默认锚定命令实际执行时刻
- 如果需要可复现历史窗口，必须显式传 `--reference-time`

示例：

```powershell
node scripts/run.mjs --mode fetch --date 2026-03-27 --reference-time 2026-03-27T08:00:00+08:00
```

### 指定种子 CSV

```powershell
node scripts/run.mjs --mode fetch --seed-csv .\X列表关注者.daily.csv
```

显式传入 `--seed-csv` 时，不会先自动准备 daily roster。

### 指定抓取批次

```powershell
node scripts/run.mjs --mode fetch --batch-size 8
```

### 启用 precheck

```powershell
# 默认不启用 precheck；如需省调用量，可在 config.json 中将
# fetch.profiles.grok-default.precheck.enabled 改为 true。
node scripts/run.mjs --mode fetch
```

### 切换分析模型

```powershell
node scripts/run.mjs --mode analyze --analysis-profile claude-default
```

## 配置说明

`config.example.json` 展示了完整结构。几个关键点：

- `defaults.outputDir`
  产物根目录，默认 `./data`
- `fetch.activeProfile`
  默认抓取配置，当前是 `grok-default`
- `fetch.profiles.grok-default.seedCsvPath`
  抓取所用名单路径
- `fetch.profiles.grok-default.timeWindowHours`
  抓取时间窗口，默认 `24`
- `fetch.profiles.grok-default.batchSize`
  每个 Grok 请求包含的账号数
- `fetch.profiles.grok-default.precheck`
  抓取前休眠预检查；默认关闭，以优先保证 X 信息流覆盖面
- `analysis.activeProfile`
  默认分析配置，当前是 `gpt-default`
- `analysis.profiles.gpt-default.maxOutputTokens`
  分析阶段输出上限，也会约束 roster 账号评分的动态输出预算
- `analysis.profiles.gpt-default.*ModelRef`
  按阶段绑定模型，默认终稿主模型走 `gpt-main`，fallback、screening、roster 走 `gpt-main-mini`
- `roster.scoring.batchSize`
  每批送入账号评分模型的账号数，默认 `20`
- `roster.scoring.maxTweetsPerAccount`
  每个账号进入评分 prompt 的最近推文上限，默认 `3`
- `providers.*.configSource`
  从外部凭据文件映射 provider 配置

仓库内配置是安全模板，不应包含真实密钥。

roster 账号评分的输出 token 预算会随批次账号数增长：基础值为 `1500`，超过 3 个账号后按账号追加预算，并受 `maxOutputTokens` 和内部硬上限 `8000` 约束。这样可以降低请求次数，同时避免 20 账号批次被固定小输出上限截断。

## 输出产物

默认输出目录：

```text
data/YYYY-MM-DD/run-*/
```

重点产物如下：

- `fetch.input.json`
  抓取输入和种子元数据
- `fetch.raw.json`
  原始批次响应和诊断信息
- `fetch.raw.csv`
  原始推文 CSV
- `fetch.tweet-index.csv`
  标准化后的推文索引
- `fetch.result.json`
  抓取结果、账号覆盖情况、warning
- `analyze.input.json`
  分析阶段输入
- `analyze.result.json`
  分析元数据和模型输出
- `final.md`
  最终日报正文，面向阅读者，不展开抓取覆盖与风险诊断
- `maintenance.json`
  云端发布时生成的维护诊断摘要，包含质量状态、覆盖情况、抓取诊断和相关产物 key

如果只想看日报，直接打开 `final.md`。如果要检查覆盖与风险，优先看 `analyze.result.json`；云端发布后也可以看 `maintenance.json`。

## 测试

运行全部测试：

```powershell
node --test (Get-ChildItem test -Filter *.test.mjs | ForEach-Object { $_.FullName })
```

真实 API 验收：

```powershell
$env:X_MONITOR_RUN_LIVE='1'
node --test test/live.acceptance.test.mjs
```

真实验收会受网络、限流和内容波动影响，不能替代本地单元测试。

## GitHub Actions 与云端发布

仓库已包含两个主要 workflow：

- `.github/workflows/daily-report.yml`
  定时完整执行抓取、分析、发布
- `.github/workflows/fetch-smoke.yml`
  对 Grok 抓取链路做轻量冒烟检查

云端发布链路：

1. GitHub Actions 运行主流程
2. 结果写入 Cloudflare R2
3. Cloudflare Worker 从 R2 读取并提供：
   - `/`
   - `/history`
   - `/raw/latest`
   - `/maintenance/latest`

详细部署步骤见 [`部署教程.md`](./部署教程.md)。

### GitHub Actions Secrets 配置

`daily-report.yml` 会从 GitHub Secrets 读取运行时配置，并临时生成 `.tmp/github-actions/search.json` 和 `.tmp/github-actions/openclaw.json`。这些文件只在 Actions runner 内使用，不应提交到仓库。

#### Grok 抓取配置

```text
GROK_API_KEY = <Grok 或中转站提供的 API Key>
GROK_BASE_URL = https://api.x.ai/v1
GROK_MODEL = grok-4.1-fast
```

- `GROK_API_KEY`：用于抓取推文的 Grok 兼容接口密钥。
- `GROK_BASE_URL`：Grok 兼容接口地址。workflow 会用它探测 `/models`，如果没有写 `/v1`，会在探测时补成 `/v1`。
- `GROK_MODEL`：抓取阶段模型 ID。留空时默认优先使用 `grok-4.1-fast`，并在可用模型中回退选择。

#### OpenAI-compatible 分析配置

如果使用 AnyRouter 这类中转站，地址应写在 `OPENAI_BASE_URL`，模型 ID 才写在 `OPENAI_*_MODEL`：

```text
OPENAI_API_KEY = <中转站或 OpenAI-compatible 服务的 API Key>
OPENAI_BASE_URL = https://anyrouter.top/v1
OPENAI_BRIEF_MODEL = gpt-5.4
OPENAI_BRIEF_FALLBACK_MODEL = gpt-5.4-mini
OPENAI_SCREENING_MODEL = gpt-5.4-mini
OPENAI_ROSTER_MODEL = gpt-5.4-mini
```

变量含义：

- `OPENAI_API_KEY`：分析链路使用的 API Key。它必须和 `OPENAI_BASE_URL` 指向的服务匹配。
- `OPENAI_BASE_URL`：OpenAI-compatible API 地址，例如 `https://anyrouter.top/v1`。脚本会在该地址后请求 `/responses`，所以最终请求会到 `https://anyrouter.top/v1/responses`。
- `OPENAI_BRIEF_MODEL`：终稿日报主模型，只能填模型 ID，例如 `gpt-5.4`。
- `OPENAI_BRIEF_FALLBACK_MODEL`：终稿主模型失败后的 fallback 模型，例如 `gpt-5.4-mini`。
- `OPENAI_SCREENING_MODEL`：高价值推文筛选模型，例如 `gpt-5.4-mini`。
- `OPENAI_ROSTER_MODEL`：账号评分模型，例如 `gpt-5.4-mini`。

不要这样配置：

```text
OPENAI_BRIEF_MODEL = https://anyrouter.top/v1
```

`OPENAI_BRIEF_MODEL` 不是中转站 API 地址。把 URL 填进模型变量后，workflow 会把它当成模型 ID 写入配置，最终模型请求会变成“用名为 `https://anyrouter.top/v1` 的模型生成日报”，这通常会导致模型不可用、请求失败或 fallback 报告。

如果这些模型 Secrets 留空，workflow 会使用下面的低成本默认值：

```text
OPENAI_BRIEF_MODEL = gpt-5.4
OPENAI_BRIEF_FALLBACK_MODEL = gpt-5.4-mini
OPENAI_SCREENING_MODEL = gpt-5.4-mini
OPENAI_ROSTER_MODEL = gpt-5.4-mini
```

如果公开报告中出现：

```text
401 Invalid API key，请检查模型可用性
```

优先检查：

1. `OPENAI_API_KEY` 是否填写、是否过期、是否属于 `OPENAI_BASE_URL` 对应的中转站。
2. `OPENAI_BASE_URL` 是否正确，例如 AnyRouter 应是 `https://anyrouter.top/v1`，不要填到模型变量里。
3. `OPENAI_BRIEF_MODEL`、`OPENAI_BRIEF_FALLBACK_MODEL`、`OPENAI_SCREENING_MODEL`、`OPENAI_ROSTER_MODEL` 是否是该中转站实际支持的模型 ID。
4. 中转站控制台里该模型是否启用、余额是否充足、账号是否有调用权限。
5. GitHub Actions 日志里的 `Using OPENAI_*_RUNTIME_MODEL=...` 是否显示了预期模型 ID。

#### Cloudflare R2 与 Worker 发布配置

```text
R2_ACCOUNT_ID = <Cloudflare account id>
R2_ACCESS_KEY_ID = <R2 access key id>
R2_SECRET_ACCESS_KEY = <R2 secret access key>
R2_BUCKET_NAME = <R2 bucket name>
CLOUDFLARE_API_TOKEN = <Cloudflare API token>
CLOUDFLARE_ACCOUNT_ID = <Cloudflare account id>
```

- `R2_*`：用于把 `final.html`、`final.md`、`latest.json`、`maintenance.json` 等产物上传到 R2。
- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`：用于部署或更新 Cloudflare Worker。
- workflow 会同时把 `R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY` 映射成 AWS CLI 需要的 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`。

## OpenClaw 使用方式

如果你希望通过 OpenClaw 使用这个 skill：

```powershell
openclaw skills list
openclaw skills info x-monitor
```

常见前提：

- skill 目录位于 OpenClaw workspace 内
- 当前目录存在 `SKILL.md`
- `~/.openclaw/openclaw.json` 已完成配置

## 安全与公开仓库注意事项

这个仓库默认按公开仓库思路整理，真实密钥不应写入以下位置：

- `config.json`
- `config.example.json`
- prompts
- tests
- docs
- workflow YAML

真实密钥只应放在：

- OpenClaw 外部凭据文件
- GitHub Secrets
- Cloudflare 控制台

建议不要提交以下本地产物：

- `config.live-probe*.json`
- `config.rerun*.json`
- `.gh-cache/`
- `.tmp/`
- `data/`
- `*.csv`
- `account-score.json`
- `*.bak`
- 本地日志与压缩包

如果你计划把仓库设为 `public`，还要特别注意：

- GitHub Actions 历史日志会变成公开可见
- 日志里即使密钥被掩码，也可能暴露内部接口域名、抓取名单和运行细节
- 公共文档里不要出现你的本机用户名路径和私有服务地址

## 常见问题

### `openclaw` 命令找不到

先检查：

```powershell
openclaw --version
node -v
npm -v
```

### skill 没被识别

先检查：

```powershell
openclaw skills list
openclaw skills info x-monitor
```

### Grok 抓取为 0

优先检查：

1. `X列表关注者.daily.csv` 是否为空
2. 当前 24 小时窗口内是否确实有内容
3. `fetch.result.json` 中的 `warnings`
4. 凭据文件是否可读

### GPT 日报为空

优先检查：

1. `fetch.result.json` 是否有有效推文
2. `analyze.result.json` 中的诊断信息
3. 是否因为超时、限流或窗口过滤导致输入为空

## 相关文档

- [`部署教程.md`](./部署教程.md)
- [`references/output-schema.md`](./references/output-schema.md)
- [`references/x-monitor-requirements-2026-03-23.md`](./references/x-monitor-requirements-2026-03-23.md)
- [`SKILL.md`](./SKILL.md)
