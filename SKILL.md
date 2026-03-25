---
name: x-monitor
description: Read a local X roster CSV, use Grok to fetch each account's last 24 hours of tweets in batches, then use GPT or Claude to screen high-value items into a daily brief.
---

# X Monitor

## What This Skill Does

`x-monitor` is a CSV-seeded X tweet monitoring pipeline:

1. `fetch`
   - Reads a local roster CSV such as `X 列表关注者.csv`
   - Normalizes account seeds from fields like `Handle`, `Name`, `Bio`, and `UserPageURL`
   - Calls Grok in batches to fetch the last 24 hours of tweets for those accounts
   - Includes original tweets, reposts, and quote tweets
   - Excludes pure replies
   - Writes `fetch.input.json`, `fetch.raw.json`, `fetch.raw.csv`, and `fetch.result.json`

2. `analyze`
   - Reads `fetch.result.json`
   - Builds a tweet evidence block plus account coverage summary
   - Calls the configured analysis model
   - Writes `analyze.input.json`, `analyze.result.json`, and `final.md`

3. `run`
   - Executes `fetch` then `analyze`

Use this skill when the user wants:
- “用本地 CSV 名单抓过去 24 小时的 X 推文流并做日报”
- A daily tweet brief grounded in a fixed account roster
- Auditable fetch artifacts plus an editorial summary

Do not use this skill for:
- Profile enrichment or roster auditing
- Editing provider secrets inside the skill directory
- OpenClaw core config changes

## Entry Points

```bash
# Full pipeline
node scripts/run.mjs --mode run

# Fetch only
node scripts/run.mjs --mode fetch

# Analyze only (requires an existing fetch.result.json for the same date)
node scripts/run.mjs --mode analyze

# Override run date
node scripts/run.mjs --mode run --date 2026-03-23

# Override the seed CSV path
node scripts/run.mjs --mode fetch --seed-csv ".\\X 列表关注者.csv"

# Override batch size for Grok fetch
node scripts/run.mjs --mode fetch --batch-size 8

# Re-run analysis with Claude profile
node scripts/run.mjs --mode analyze --analysis-profile claude-default
```

## Artifacts

Artifacts are written under `data/YYYY-MM-DD/` in this skill directory.

- `fetch.input.json`
  Normalized roster seeds plus fetch-stage task metadata.
- `fetch.raw.json`
  Per-batch raw Grok responses, parse errors, and audit metadata.
- `fetch.raw.csv`
  Combined raw tweet CSV extracted from successful Grok batches.
- `fetch.result.json`
  Normalized tweet items, account coverage statuses, and warnings.
- `analyze.input.json`
  The tweet evidence package passed into the analysis stage.
- `analyze.result.json`
  Analysis metadata plus the model’s Markdown output.
- `final.md`
  Final human-readable daily brief.

See `references/output-schema.md` for the schema summary.

## Configuration Files

### 1. `config.json`

Skill-local runtime config. This file is safe to keep in the skill directory because it should only contain:

- runtime profile selection
- prompt file paths
- artifact file names
- external credential file paths
- model IDs
- local seed CSV path
- tweet-fetch scope settings such as `timeWindowHours`

It should **not** contain real API keys.

`config.example.json` is the template copy for new setups.

Important sections:

- `defaults.outputDir`
  Artifact root, default `./data`
- `fetch.activeProfile`
  Default fetch profile, currently `grok-default`
- `fetch.profiles.*.seedCsvPath`
  The local roster CSV file
- `fetch.profiles.*.batchSize`
  How many accounts go into one Grok request
- `fetch.profiles.*.timeWindowHours`
  Time window for the tweet fetch, default `24`
- `fetch.profiles.*.includeTweetTypes`
  Included post types, default `["original", "repost", "quote"]`
- `fetch.profiles.*.excludePureReplies`
  Whether pure replies are excluded
- `analysis.activeProfile`
  Default analysis profile, currently `gpt-default`
- `sources.credentialFiles`
  External JSON files that hold provider credentials

### 2. External credential sources

`x-monitor` reads secrets from external files and maps them through `providers.*.configSource`.

- `sources.credentialFiles.search`
  Expected to point to a file like `C:/Users/bing/.openclaw/credentials/search.json`
  Provides Grok fetch credentials.
- `sources.credentialFiles.openclaw`
  Expected to point to a file like `C:/Users/bing/.openclaw/openclaw.json`
  Provides GPT / Claude analysis credentials already managed by OpenClaw.

The skill only reads those files. It does not modify them.

## Provider Behavior

### Fetch provider

`fetch` is wired to Grok because the skill needs live X/Twitter tweet retrieval.

Relevant config path:

```json
"fetch": {
  "activeProfile": "grok-default"
}
```

### Analysis provider

The default analysis path is GPT.

Relevant config path:

```json
"analysis": {
  "activeProfile": "gpt-default"
}
```

`gpt-default` resolves through OpenClaw’s `router-gpt` provider and `gpt-main` model mapping.

Claude is a supported switch path, not the default. To use it later:

- set `analysis.activeProfile` to `claude-default`, or
- pass `--analysis-profile claude-default`

That profile resolves through OpenClaw’s `anyrouter` provider and `claude-main` model mapping.

Both analysis profiles currently reuse `assets/prompts/gpt-analyze.txt`.

## Prompt Templates

- `assets/prompts/grok-fetch.txt`
  Used by `fetch`
  Variables: `{{TIME_WINDOW_HOURS}}`, `{{SEED_COUNT}}`, `{{INCLUDE_TWEET_TYPES}}`, `{{EXCLUDE_RULES}}`, `{{SEED_BATCH_JSON}}`
- `assets/prompts/gpt-analyze.txt`
  Used by `analyze`
  Variables: `{{REPORT_DATE}}`, `{{TWEET_EVIDENCE_BLOCK}}`

## Script Map

- `scripts/run.mjs`
  CLI entry point for `fetch`, `analyze`, and `run`
- `scripts/fetch.mjs`
  Reads the roster CSV, batches Grok tweet fetches, normalizes tweet items, records account coverage, and writes fetch artifacts
- `scripts/analyze.mjs`
  Screens the fetched tweet evidence into an editorial daily brief
- `scripts/config-loader.mjs`
  Loads `config.json` and credential documents
- `scripts/provider-resolver.mjs`
  Resolves providers, profiles, and model IDs
- `scripts/artifact-store.mjs`
  Creates run folders and reads/writes artifacts
- `scripts/openai-compatible-client.mjs`
  Shared OpenAI-compatible HTTP client with retry support

## Validation

Primary test command:

```bash
node tests/x-monitor.test.mjs
```

Standalone smoke validation:

```bash
node tests/smoke-run.mjs
```

Current test coverage includes:

- JSON path resolution
- provider/profile resolution for GPT and Claude
- CSV seed parsing and normalization
- Grok tweet CSV parsing and normalization
- coverage fallback when a batch cannot be parsed
- analyze input formatting around tweet evidence instead of profile evidence
- smoke validation for `runFetch`
- smoke validation for `runAnalyze`

## Safe Usage Rules

- Keep all work inside this skill directory unless a task explicitly requires otherwise.
- Do not edit OpenClaw core config files such as `C:/Users/bing/.openclaw/openclaw.json`.
- Do not place real secrets in `config.json`, `config.example.json`, prompts, tests, or docs in this skill.
- Treat external credential files as read-only inputs.

## Known Limitations

- Fetch is Grok-only right now.
- Large roster CSV inputs may take multiple batch requests.
- If a Grok batch fails or returns non-CSV text, the skill still writes artifacts and marks affected accounts as `fetch_failed`.
- Re-running the same date overwrites artifacts for that date.
- “每天 8:00 自动跑并主动发送日报” 仍需要 skill 外部的 cron / OpenClaw core integration；本 skill 只在 repo 内保留清晰接入边界，不伪装成已完成。
