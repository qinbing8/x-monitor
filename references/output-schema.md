# x-monitor output schema

## fetch.input.json

```json
{
  "task": {
    "goal": "Fetch the last 24 hours of X tweets from a local CSV roster via Grok",
    "fetchProfile": "grok-default",
    "provider": "grok",
    "model": "grok-4.1-fast",
    "sourceCsvPath": "C:/.../X 列表关注者.csv",
    "timeWindowHours": 24,
    "includeTweetTypes": ["original", "repost", "quote"],
    "excludePureReplies": true,
    "seedCount": 24,
    "batchSize": 12,
    "batchCount": 2
  },
  "seeds": [
    {
      "seedId": "seed-1",
      "csvRowNumber": 2,
      "handle": "alice",
      "displayName": "Alice Maker",
      "bio": "Builds tools",
      "userPageUrl": "https://x.com/alice",
      "sourceType": "account_seed"
    }
  ]
}
```

## fetch.raw.json

Raw Grok output captured per batch.

```json
{
  "meta": {
    "sourceProvider": "grok",
    "capturedAt": "ISO-8601",
    "fetchInputPath": "C:/.../fetch.input.json",
    "fetchRawCsvPath": "C:/.../fetch.raw.csv",
    "batchCount": 2
  },
  "batches": [
    {
      "batchId": "batch-1",
      "seedIds": ["seed-1", "seed-2"],
      "parseError": null,
      "rowCount": 18,
      "rawText": "username,tweet_id,created_at,text,original_url\n..."
    }
  ]
}
```

## fetch.raw.csv

Combined raw tweet CSV extracted from all parseable Grok batches.

```csv
username,tweet_id,created_at,text,original_url
alice,190001,2026-03-23T01:02:03Z,"Shipped a new CLI for tracing agent runs.",https://x.com/alice/status/190001
alice,190002,2026-03-23T05:00:00Z,"Quote: Strong write-up on eval-driven development.",https://x.com/alice/status/190002
```

## fetch.result.json

```json
{
  "meta": {
    "sourceProvider": "grok",
    "fetchedAt": "ISO-8601",
    "sourceCsvPath": "C:/.../X 列表关注者.csv",
    "timeWindowHours": 24,
    "includeTweetTypes": ["original", "repost", "quote"],
    "excludePureReplies": true,
    "seedCount": 24,
    "batchSize": 12,
    "batchCount": 2,
    "tweetCount": 18,
    "fetchInputPath": "C:/.../fetch.input.json",
    "fetchRawPath": "C:/.../fetch.raw.json",
    "fetchRawCsvPath": "C:/.../fetch.raw.csv",
    "parseErrorCount": 0,
    "coveredAccountCount": 10,
    "noTweetAccountCount": 11,
    "failedAccountCount": 2,
    "incompleteAccountCount": 1,
    "warningCount": 1
  },
  "accounts": [
    {
      "seedId": "seed-1",
      "handle": "alice",
      "displayName": "Alice Maker",
      "userPageUrl": "https://x.com/alice",
      "batchId": "batch-1",
      "status": "covered",
      "tweetCount": 2,
      "notes": []
    },
    {
      "seedId": "seed-2",
      "handle": "bob",
      "displayName": "Bob Chen",
      "userPageUrl": "https://x.com/bob",
      "batchId": "batch-1",
      "status": "no_tweets_found",
      "tweetCount": 0,
      "notes": [
        "No qualifying tweets were returned for the last 24 hours."
      ]
    }
  ],
  "items": [
    {
      "tweetId": "190001",
      "username": "alice",
      "displayName": "Alice Maker",
      "createdAt": "2026-03-23T01:02:03Z",
      "text": "Shipped a new CLI for tracing agent runs.",
      "originalUrl": "https://x.com/alice/status/190001",
      "batchId": "batch-1",
      "source": {
        "seedId": "seed-1",
        "csvRowNumber": 2,
        "seedHandle": "alice",
        "displayName": "Alice Maker",
        "userPageUrl": "https://x.com/alice"
      },
      "sourceType": "tweet"
    }
  ],
  "warnings": [
    {
      "type": "batch_parse_error",
      "batchId": "batch-2",
      "seedIds": ["seed-11", "seed-12"],
      "message": "Could not locate a tweet CSV header in the fetch response"
    }
  ]
}
```

## analyze.input.json

```json
{
  "task": {
    "goal": "Screen the last 24 hours of X tweets into an editorial daily brief",
    "analysisProfile": "gpt-default",
    "reportDate": "2026-03-23"
  },
  "evidence": {
    "meta": {
      "tweetCount": 18,
      "failedAccountCount": 2
    },
    "accounts": [
      {
        "seedId": "seed-1",
        "handle": "alice",
        "status": "covered",
        "tweetCount": 2
      }
    ],
    "items": [
      {
        "tweetId": "190001",
        "username": "alice",
        "text": "Shipped a new CLI for tracing agent runs."
      }
    ],
    "warnings": []
  }
}
```

## analyze.result.json

```json
{
  "meta": {
    "analysisProfile": "gpt-default",
    "provider": "gpt",
    "model": "gpt-5.4",
    "analyzedAt": "ISO-8601",
    "analyzeInputPath": "C:/.../analyze.input.json",
    "primaryBriefModel": "gpt-5.4",
    "briefFallbackModel": "gpt-5.4",
    "generatedByFallbackModel": false,
    "primaryBriefFailureSummary": null,
    "finalDraftAttempts": [
      {
        "kind": "primary",
        "model": "gpt-5.4",
        "reasoningEffort": "xhigh",
        "status": "succeeded",
        "durationMs": 84213,
        "continuationRounds": 0,
        "truncated": false,
        "error": null,
        "errorSummary": null
      }
    ],
    "tweetCount": 18,
    "coverage": {
      "totalAccountCount": 24,
      "coveredAccountCount": 10,
      "noTweetAccountCount": 11,
      "failedAccountCount": 2,
      "incompleteAccountCount": 1
    }
  },
  "answer": {
    "source": "model",
    "generatedBy": "primary_model",
    "note": null,
    "markdown": "# X 日报 | 2026-03-23\n..."
  },
  "quality": {
    "needsReview": true,
    "note": "Some accounts were not fully covered. Review the coverage gap section before forwarding the brief."
  }
}
```

## final.md

Human-readable final report generated by the selected analysis model.

Required structure:

1. `## 今日要点摘要（Deep Brief）`
2. `## 编辑精选（Editor's Choice）`
3. `## 高价值推文完整清单`
4. `## 抓取覆盖与缺口`

Optional:

- `## 低信噪比账号提醒`
