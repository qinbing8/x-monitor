import { readFile } from 'node:fs/promises';
import { loadConfig, loadSourceDocuments, resolveMaybeRelative } from './config-loader.mjs';
import { resolveFetchProfile } from './provider-resolver.mjs';
import { ensureRunDir, writeJsonArtifact, writeTextArtifact, resolveRunDate } from './artifact-store.mjs';
import { createLogger } from './logger.mjs';
import { postChatCompletions, withRetry } from './openai-compatible-client.mjs';
import { mapWithConcurrency } from './parallel.mjs';

const CSV_FENCE_RE = /```(?:csv|text)?\s*([\s\S]*?)```/i;
const CSV_HEADER_RE = /(^|\n)\s*"?username"?\s*,\s*"?tweet_id"?\s*,\s*"?created_at"?\s*,\s*"?text"?\s*,\s*"?original_url"?/i;
const REQUIRED_TWEET_FIELDS = ['username', 'tweet_id', 'created_at', 'text', 'original_url'];
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_TWEET_URL_RE = /^https?:\/\/(?:www\.)?x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/i;
const TWEET_ROW_START_RE = /^\s*"?(?<username>[A-Za-z0-9_]{1,15})"?\s*,\s*"?(?<tweetId>\d+)"?\s*,\s*"?(?<createdAt>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"?\s*,/;
const TWEET_URL_FIELD_AT_END_RE = /,\s*"?(https?:\/\/(?:www\.)?x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+)"?\s*$/i;
const MS_PER_HOUR = 60 * 60 * 1000;
const NO_TWEET_NOTE = 'No qualifying tweets were returned for the last 24 hours.';
const OUTSIDE_TIME_WINDOW_REASON = 'Tweet is outside the configured time window';

const SOFT_FAIL_NARRATIVES = [
  /no\s+(matching\s+)?posts?\s+found/i,
  /no\s+tweets?\s+(were\s+)?(found|available|posted)/i,
  /did\s+not\s+(find|post|tweet)/i,
  /no\s+activity/i,
  /no\s+results?/i,
  /there\s+are\s+no/i,
  /i\s+(couldn'?t|could\s+not|was\s+unable\s+to)\s+find/i,
  /unfortunately/i,
  /i\s+don'?t\s+have\s+access/i,
];

export function classifyRawResponse(rawText, csvRecordCount) {
  const text = String(rawText ?? '').trim();
  if (!text) return { classification: 'empty_response', detail: 'Response body is empty' };

  const hasHeader = CSV_HEADER_RE.test(text);
  const normalizedText = stripCodeFences(text);
  const normalizedLines = normalizedText.split(/\r?\n/).filter((line) => line.trim());
  if (!hasHeader && csvRecordCount > 0 && normalizedLines.length > 0 && TWEET_ROW_START_RE.test(normalizedLines[0])) {
    return { classification: 'headerless_csv', detail: 'Recovered data rows without a CSV header' };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const nonHeaderLines = hasHeader ? lines.slice(1).filter((line) => !CSV_HEADER_RE.test(line)) : lines;
  const nonHeaderText = nonHeaderLines.join(' ').trim();

  if (hasHeader && csvRecordCount > 0) return { classification: 'valid', detail: null };

  if (hasHeader && csvRecordCount === 0) {
    const hasNarrative = SOFT_FAIL_NARRATIVES.some((re) => re.test(nonHeaderText));
    if (!nonHeaderText || nonHeaderText.length < 5) {
      return { classification: 'header_only', detail: 'Response contains CSV header but no data rows' };
    }
    if (hasNarrative) {
      return { classification: 'header_with_narrative', detail: `Header followed by no-data explanation: "${nonHeaderText.slice(0, 120)}"` };
    }
    return { classification: 'header_only', detail: 'Response contains CSV header but no parseable data rows' };
  }

  const isNarrative = SOFT_FAIL_NARRATIVES.some((re) => re.test(text));
  if (isNarrative) {
    return { classification: 'narrative_only', detail: `No-data narrative without CSV structure: "${text.slice(0, 120)}"` };
  }

  return { classification: 'unstructured', detail: `Unrecognized response format (${text.length} chars)` };
}

export function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => String(vars[key] ?? ''));
}

export function stripCodeFences(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```$/m, '')
    .trim();
}

export function parseCsv(csvText) {
  const input = stripCodeFences(csvText);
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== '')) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => String(header).replace(/^\uFEFF/, '').trim());
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, idx) => [header, cells[idx] ?? ''])));
}

function consumeCsvField(input, startIndex = 0) {
  let index = startIndex;
  while (index < input.length && /\s/.test(input[index]) && input[index] !== '\n') index += 1;
  if (index >= input.length) {
    return { value: '', nextIndex: index };
  }

  if (input[index] === '"') {
    index += 1;
    let value = '';
    while (index < input.length) {
      const char = input[index];
      const next = input[index + 1];
      if (char === '"' && next === '"') {
        value += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        break;
      }
      value += char;
      index += 1;
    }
    while (index < input.length && /\s/.test(input[index]) && input[index] !== '\n') index += 1;
    if (input[index] === ',') index += 1;
    return { value, nextIndex: index };
  }

  let endIndex = index;
  while (endIndex < input.length && input[endIndex] !== ',') endIndex += 1;
  const value = input.slice(index, endIndex).trim();
  if (input[endIndex] === ',') endIndex += 1;
  return { value, nextIndex: endIndex };
}

function unquoteCsvField(value) {
  const text = String(value ?? '').trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/""/g, '"');
  }
  return text;
}

function splitRecoveredTweetRowBlocks(csvText, options = {}) {
  const hasHeader = options.hasHeader !== false;
  const lines = String(csvText ?? '').replace(/\r/g, '').split('\n');
  const rowBlocks = [];
  let currentBlock = '';

  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    if (TWEET_ROW_START_RE.test(line)) {
      if (currentBlock) rowBlocks.push(currentBlock);
      currentBlock = line;
      continue;
    }
    if (!currentBlock) continue;
    if (TWEET_URL_FIELD_AT_END_RE.test(currentBlock)) continue;
    currentBlock += `\n${line}`;
  }

  if (currentBlock) rowBlocks.push(currentBlock);
  return rowBlocks;
}

function parseRecoveredTweetRow(rowBlock) {
  if (!TWEET_ROW_START_RE.test(rowBlock)) return null;

  const usernameField = consumeCsvField(rowBlock, 0);
  const tweetIdField = consumeCsvField(rowBlock, usernameField.nextIndex);
  const createdAtField = consumeCsvField(rowBlock, tweetIdField.nextIndex);
  const remainder = rowBlock.slice(createdAtField.nextIndex);
  const urlMatch = remainder.match(TWEET_URL_FIELD_AT_END_RE);
  const textPart = urlMatch ? remainder.slice(0, urlMatch.index) : remainder;
  const originalUrl = urlMatch?.[1] ?? '';
  const text = unquoteCsvField(textPart).replace(/\\n/g, '\n').trim();

  return {
    username: usernameField.value,
    tweet_id: tweetIdField.value,
    created_at: createdAtField.value,
    text,
    original_url: originalUrl,
  };
}

function parseRecoveredTweetCsv(csvText, options = {}) {
  const rowBlocks = splitRecoveredTweetRowBlocks(csvText, options);
  const records = rowBlocks
    .map((rowBlock) => parseRecoveredTweetRow(rowBlock))
    .filter(Boolean);
  return {
    rowBlockCount: rowBlocks.length,
    records,
  };
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function buildSeedIdentityKey(seed) {
  const sourceTweetId = trimString(seed?.sourceTweetId);
  if (sourceTweetId) return `tweet:${sourceTweetId}`;
  const handle = trimString(seed?.handle).toLowerCase();
  const userPageUrl = trimString(seed?.userPageUrl).toLowerCase();
  const displayName = trimString(seed?.displayName).toLowerCase();
  return `${handle}|${userPageUrl}|${displayName}`;
}

function normalizeUrl(value) {
  const text = trimString(value);
  return text.replace(/\/+$/, '');
}

function normalizeHandle(value, fallbackUrl = '') {
  const text = trimString(value).replace(/^@/, '');
  if (text) return text;
  const url = normalizeUrl(fallbackUrl);
  const match = url.match(/x\.com\/([^/?#]+)/i);
  return match?.[1] ?? '';
}

function normalizeNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function pickString(...values) {
  for (const value of values) {
    const normalized = trimString(value);
    if (normalized) return normalized;
  }
  return '';
}

function pickNumber(...values) {
  for (const value of values) {
    const normalized = normalizeNumber(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function pickBoolean(...values) {
  for (const value of values) {
    const normalized = normalizeBoolean(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function chunkArray(items, chunkSize) {
  const size = Math.max(1, Number(chunkSize) || 1);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function escapeCsvValue(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function serializeCsv(records, headers = REQUIRED_TWEET_FIELDS) {
  const headerLine = headers.join(',');
  const rowLines = records.map((record) => headers.map((header) => escapeCsvValue(record[header] ?? '')).join(','));
  return [headerLine, ...rowLines].join('\n');
}

function buildPromptSeedRecords(seeds) {
  return seeds.map((seed) => ({
    seed_id: seed.seedId,
    source_tweet_id: seed.sourceTweetId || null,
    handle: seed.handle || null,
    display_name: seed.displayName || null,
    user_page_url: seed.userPageUrl || null,
    bio: seed.bio || null,
  }));
}

function normalizeTweetUrl(value, username, tweetId) {
  const directUrl = normalizeUrl(value);
  if (directUrl) return directUrl;
  const handle = normalizeHandle(username);
  return handle && tweetId ? `https://x.com/${handle}/status/${tweetId}` : '';
}

function parseTimestampMs(value) {
  const normalized = trimString(value);
  if (!normalized) return null;
  const hasTimezone = /[Zz]$/.test(normalized) || /[+-]\d{2}:?\d{2}$/.test(normalized);
  if (!hasTimezone) {
    const withZ = `${normalized}Z`;
    const parsed = Date.parse(withZ);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValidTweetId(value) {
  return /^\d+$/.test(trimString(value));
}

function hasValidHandle(value) {
  return X_HANDLE_RE.test(trimString(value));
}

function hasValidTweetUrl(value) {
  return X_TWEET_URL_RE.test(normalizeUrl(value));
}

function inspectTweetRecord(record) {
  const username = normalizeHandle(record.username ?? record.handle ?? '', record.original_url ?? record.originalUrl ?? '');
  const tweetId = trimString(record.tweet_id ?? record.tweetId ?? record.id);
  const createdAt = trimString(record.created_at ?? record.createdAt ?? record.posted_at);
  const createdAtMs = parseTimestampMs(createdAt);
  const text = pickString(record.text, record.full_text, record.content);
  const originalUrl = normalizeTweetUrl(record.original_url ?? record.originalUrl ?? record.url, username, tweetId);

  const fieldIssues = [];
  if (!username) fieldIssues.push('username');
  else if (!hasValidHandle(username)) fieldIssues.push('username');
  if (!tweetId) fieldIssues.push('tweet_id');
  else if (!hasValidTweetId(tweetId)) fieldIssues.push('tweet_id');
  if (!createdAt) fieldIssues.push('created_at');
  else if (createdAtMs === null) fieldIssues.push('created_at');
  if (!text) fieldIssues.push('text');
  if (!originalUrl) fieldIssues.push('original_url');
  else if (!hasValidTweetUrl(originalUrl)) fieldIssues.push('original_url');

  return {
    username,
    tweetId,
    createdAt,
    createdAtMs,
    text,
    originalUrl,
    fieldIssues,
    hasTweetIdentityShape:
      hasValidTweetId(tweetId)
      && createdAtMs !== null
      && hasValidHandle(username)
      && hasValidTweetUrl(originalUrl),
  };
}

function summarizeTweetRecordQuality(records) {
  let validIdentityCount = 0;
  let invalidFieldCount = 0;

  for (const record of records) {
    const inspected = inspectTweetRecord(record);
    if (inspected.fieldIssues.length === 0) {
      validIdentityCount += 1;
    } else {
      invalidFieldCount += 1;
    }
  }

  return {
    recordCount: records.length,
    validIdentityCount,
    invalidFieldCount,
  };
}

function filterTweetCsvRecords(records) {
  return records.filter((record) => inspectTweetRecord(record).hasTweetIdentityShape);
}

function countWindowDroppedRows(rowIssues) {
  return rowIssues.filter((issue) => issue.reason === OUTSIDE_TIME_WINDOW_REASON).length;
}

function splitRowIssues(rowIssues = []) {
  const blockingIssues = [];
  const outsideWindowIssues = [];

  for (const issue of Array.isArray(rowIssues) ? rowIssues : []) {
    if (issue?.reason === OUTSIDE_TIME_WINDOW_REASON) {
      outsideWindowIssues.push(issue);
      continue;
    }
    blockingIssues.push(issue);
  }

  return { blockingIssues, outsideWindowIssues };
}

function resolveReferenceTime(referenceTime) {
  if (referenceTime != null) {
    const referenceDate = new Date(referenceTime);
    if (Number.isNaN(referenceDate.getTime())) {
      throw new Error(`Invalid referenceTime: ${referenceTime}`);
    }
    return referenceDate.toISOString();
  }
  return new Date().toISOString();
}

function isWithinTimeWindow(createdAtMs, referenceTimeMs, timeWindowHours) {
  if (createdAtMs === null || referenceTimeMs === null) return true;
  const effectiveHours = Math.max(1, Number(timeWindowHours ?? 24) || 24);
  const windowStartMs = referenceTimeMs - (effectiveHours * MS_PER_HOUR);
  return createdAtMs >= windowStartMs && createdAtMs <= referenceTimeMs;
}

function findSeedForTweetRecord(seeds, record) {
  const username = normalizeHandle(record.username ?? record.handle ?? '', record.original_url ?? record.originalUrl ?? '');
  if (!username) return null;
  return seeds.find((seed) => seed.handle && seed.handle.toLowerCase() === username.toLowerCase()) ?? null;
}

export function extractCsvPayload(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '').trim();
  const candidates = [];
  const fenced = input.match(CSV_FENCE_RE);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(input);

  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').replace(/^\uFEFF/, '').trim();
    const match = normalized.match(CSV_HEADER_RE);
    if (!match) continue;
    const prefixLength = match[1] ? match[1].length : 0;
    const startIndex = (match.index ?? 0) + prefixLength;
    return normalized.slice(startIndex).trim();
  }

  throw new Error('Could not locate a tweet CSV header in the fetch response');
}

function extractHeaderlessCsvPayload(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '').trim();
  const candidates = [];
  const fenced = input.match(CSV_FENCE_RE);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(input);

  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').replace(/^\uFEFF/, '').trim();
    const lines = normalized.split(/\r?\n/);
    const firstRowIndex = lines.findIndex((line) => TWEET_ROW_START_RE.test(line));
    if (firstRowIndex < 0) continue;
    return lines.slice(firstRowIndex).join('\n').trim();
  }

  throw new Error('Could not locate headerless tweet CSV rows in the fetch response');
}

export function parseTweetCsvResponse(text) {
  let csvText;
  let hasHeader = true;
  try {
    csvText = extractCsvPayload(text);
  } catch (error) {
    csvText = extractHeaderlessCsvPayload(text);
    hasHeader = false;
  }

  const strictRecords = hasHeader ? parseCsv(csvText) : [];
  const recovered = parseRecoveredTweetCsv(csvText, { hasHeader });
  const strictStats = summarizeTweetRecordQuality(strictRecords);
  const recoveredStats = summarizeTweetRecordQuality(recovered.records);
  const useRecovered =
    !hasHeader
    || (
    recoveredStats.validIdentityCount > strictStats.validIdentityCount
    || (
      recoveredStats.validIdentityCount === strictStats.validIdentityCount
      && recoveredStats.validIdentityCount > 0
      && recoveredStats.invalidFieldCount < strictStats.invalidFieldCount
      && recovered.rowBlockCount >= strictStats.validIdentityCount
    ));

  return {
    csvText,
    records: useRecovered ? recovered.records : strictRecords,
    parserDiagnostics: {
      strategy: !hasHeader ? 'headerless_rows' : useRecovered ? 'recovered_rows' : 'strict_csv',
      strict: strictStats,
      recovered: {
        ...recoveredStats,
        rowBlockCount: recovered.rowBlockCount,
      },
      hasHeader,
    },
  };
}

export function normalizeSeedAccounts(records) {
  const normalized = [];
  const seen = new Set();

  for (const [index, record] of records.entries()) {
    const userPageUrl = normalizeUrl(record.UserPageURL ?? record.userPageUrl ?? record.user_page_url ?? '');
    const handle = normalizeHandle(record.Handle ?? record.handle ?? record.username ?? '', userPageUrl);
    const item = {
      seedId: `seed-${index + 1}`,
      csvRowNumber: index + 2,
      sourceTweetId: trimString(record.TweetID ?? record.tweet_id ?? ''),
      handle,
      displayName: pickString(record.Name, record.name, record.display_name),
      bio: pickString(record.Bio, record.bio),
      canDm: pickBoolean(record.CanDM, record.canDm),
      accountCreatedAt: pickString(record.AccountCreateDate, record.account_created_at),
      location: pickString(record.Location, record.location),
      followersCount: pickNumber(record.FollowersCount, record.followers_count),
      followingCount: pickNumber(record.FollowingCount, record.following_count),
      totalFavouritesByUser: pickNumber(record.TotalFavouritesByUser, record.total_favourites_by_user),
      mediaCount: pickNumber(record.MediaCount, record.media_count),
      userPageUrl,
      profileBannerUrl: normalizeUrl(record.ProfileBannerURL ?? record.profile_banner_url ?? ''),
      profileUrl: normalizeUrl(record.ProfileURL ?? record.profile_url ?? ''),
      avatarUrl: normalizeUrl(record.AvatarURL ?? record.avatar_url ?? ''),
      postCount: pickNumber(record.PostCount, record.post_count, record.posts_count),
      verified: pickBoolean(record.Verified, record.verified),
      isBlueVerified: pickBoolean(record.IsBlueVerified, record.blue_verified, record.is_blue_verified),
      sourceType: 'account_seed',
    };
    if (!item.handle && !item.userPageUrl && !item.displayName && !item.bio) continue;
    const dedupeKey = buildSeedIdentityKey(item);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(item);
  }

  return normalized;
}

export function normalizeTweetRecords(seeds, records, batchId, options = {}) {
  const items = [];
  const rowIssues = [];
  const referenceTimeMs = options.referenceTime ? parseTimestampMs(options.referenceTime) : null;
  const timeWindowHours = options.timeWindowHours ?? 24;

  for (const [index, record] of records.entries()) {
    const rowNumber = index + 2;
    const inspected = inspectTweetRecord(record);
    const {
      username,
      tweetId,
      createdAt,
      createdAtMs,
      text,
      originalUrl,
      fieldIssues,
      hasTweetIdentityShape,
    } = inspected;
    const seed = findSeedForTweetRecord(seeds, record);

    if (!seed) {
      if (hasTweetIdentityShape) {
        rowIssues.push({
          batchId,
          rowNumber,
          seedId: null,
          handle: username || null,
          reason: 'Tweet row does not map to a requested account',
        });
      }
      continue;
    }

    if (fieldIssues.length > 0) {
      rowIssues.push({
        batchId,
        rowNumber,
        seedId: seed.seedId,
        handle: seed.handle || username,
        reason: `Missing or invalid required fields: ${fieldIssues.join(', ')}`,
      });
      continue;
    }

    if (!isWithinTimeWindow(createdAtMs, referenceTimeMs, timeWindowHours)) {
      rowIssues.push({
        batchId,
        rowNumber,
        seedId: seed.seedId,
        handle: seed.handle || username,
        reason: OUTSIDE_TIME_WINDOW_REASON,
      });
      continue;
    }

    items.push({
      tweetId,
      username: seed.handle || username,
      displayName: seed.displayName,
      createdAt,
      text,
      originalUrl,
      batchId,
      source: {
        seedId: seed.seedId,
        sourceTweetId: seed.sourceTweetId || null,
        csvRowNumber: seed.csvRowNumber,
        seedHandle: seed.handle,
        displayName: seed.displayName,
        userPageUrl: seed.userPageUrl,
      },
      sourceType: 'tweet',
    });
  }

  return { items, rowIssues };
}

export function summarizeBatchCoverage(seeds, items, rowIssues, batchId, parseError = null, responseClassification = null) {
  if (parseError) {
    const isSoftFail = responseClassification && ['header_only', 'header_with_narrative', 'narrative_only', 'empty_response', 'unstructured'].includes(responseClassification);
    const status = isSoftFail ? 'soft_failed' : 'fetch_failed';
    return seeds.map((seed) => ({
      seedId: seed.seedId,
      sourceTweetId: seed.sourceTweetId || null,
      handle: seed.handle,
      displayName: seed.displayName,
      userPageUrl: seed.userPageUrl,
      batchId,
      status,
      tweetCount: 0,
      notes: [parseError],
      responseClassification,
    }));
  }

  const stats = new Map(seeds.map((seed) => [seed.seedId, { tweetCount: 0, issues: [] }]));

  for (const item of items) {
    const entry = stats.get(item.source.seedId);
    if (entry) entry.tweetCount += 1;
  }

  for (const issue of rowIssues) {
    if (!issue.seedId) continue;
    const entry = stats.get(issue.seedId);
    if (entry) entry.issues.push(issue);
  }

  return seeds.map((seed) => {
    const entry = stats.get(seed.seedId) ?? { tweetCount: 0, issues: [] };
    const issueNotes = entry.issues.map((issue) => `CSV row ${issue.rowNumber}: ${issue.reason}`);
    const { blockingIssues } = splitRowIssues(entry.issues);
    const blockingIssueNotes = blockingIssues.map((issue) => `CSV row ${issue.rowNumber}: ${issue.reason}`);
    let status = 'no_tweets_found';
    if (entry.tweetCount > 0) {
      status = blockingIssueNotes.length > 0 ? 'incomplete' : 'covered';
    } else if (issueNotes.length > 0) {
      status = 'incomplete';
    } else if (responseClassification && ['header_only', 'header_with_narrative', 'narrative_only', 'empty_response', 'unstructured'].includes(responseClassification)) {
      status = 'soft_failed';
    }

    const notes = entry.tweetCount > 0 ? [...blockingIssueNotes] : [...issueNotes];
    if (status === 'no_tweets_found') {
      notes.push(NO_TWEET_NOTE);
    } else if (status === 'soft_failed') {
      notes.push(`Grok returned a non-data response (${responseClassification})`);
    }

    return {
      seedId: seed.seedId,
      sourceTweetId: seed.sourceTweetId || null,
      handle: seed.handle,
      displayName: seed.displayName,
      userPageUrl: seed.userPageUrl,
      batchId,
      status,
      tweetCount: entry.tweetCount,
      notes,
      responseClassification,
    };
  });
}

function summarizeRequestFailure(error) {
  const diagnostics = error?.llmRequestDiagnostics ?? null;
  const retryDiagnostics = error?.retryDiagnostics ?? null;
  return {
    diagnostics,
    retryDiagnostics,
    errorClassification: diagnostics?.classification ?? null,
    errorCode: diagnostics?.errorCode ?? null,
    httpStatus: diagnostics?.httpStatus ?? null,
    latencyMs: diagnostics?.latencyMs ?? null,
    targetHost: diagnostics?.targetHost ?? null,
    targetPath: diagnostics?.targetPath ?? null,
    retryAttempt: retryDiagnostics?.attempt ?? null,
    retryMaxAttempts: retryDiagnostics?.maxAttempts ?? null,
    retryExhausted: retryDiagnostics?.exhausted ?? null,
  };
}

async function runSeedBatch({
  batch,
  batchIndex,
  batchId,
  promptTemplate,
  profile,
  fetchImpl,
  referenceTime,
  attemptKind = 'initial',
  round = 0,
  logger,
} = {}) {
  const resolvedBatchId = batchId ?? `batch-${batchIndex + 1}`;
  const timeWindowHours = profile.timeWindowHours ?? 24;
  const refTimeMs = referenceTime ? Date.parse(referenceTime) : Date.now();
  const windowEndUtc = new Date(refTimeMs).toISOString();
  const windowStartUtc = new Date(refTimeMs - timeWindowHours * MS_PER_HOUR).toISOString();
  const startedAt = Date.now();
  const renderedPrompt = renderTemplate(promptTemplate, {
    SEED_COUNT: batch.length,
    TIME_WINDOW_HOURS: timeWindowHours,
    WINDOW_START_UTC: windowStartUtc,
    WINDOW_END_UTC: windowEndUtc,
    INCLUDE_TWEET_TYPES: Array.isArray(profile.includeTweetTypes)
      ? profile.includeTweetTypes.join(', ')
      : 'original, repost, quote',
    EXCLUDE_RULES: profile.excludePureReplies === false ? 'None' : 'pure replies',
    SEED_BATCH_JSON: JSON.stringify(buildPromptSeedRecords(batch), null, 2),
  });

  let rawText = '';
  let diagnostics = null;
  logger?.info('fetch_batch_start', {
    attemptKind,
    round,
    batchId: resolvedBatchId,
    batchIndex,
    seedCount: batch.length,
    seedHandles: batch.map((seed) => seed.handle),
  });
  try {
    const completion = await withRetry(
      () => postChatCompletions({
        baseUrl: profile.provider.baseUrl,
        apiKey: profile.provider.apiKey,
        apiProtocol: profile.provider.api ?? profile.apiProtocol,
        model: profile.model,
        timeoutMs: profile.timeoutMs,
        temperature: 0,
        maxTokens: profile.maxOutputTokens ?? 4000,
        messages: [{ role: 'user', content: renderedPrompt }],
        fetchImpl,
        logger: logger?.child('llm'),
        operationName: `fetch_batch:${resolvedBatchId}`,
      }),
      profile.retry,
      { logger, operationName: `fetch_batch:${resolvedBatchId}` },
    );

    rawText = completion.text.trim();
    diagnostics = completion.diagnostics ?? null;
    const { csvText, records, parserDiagnostics } = parseTweetCsvResponse(rawText);
    const { items, rowIssues } = normalizeTweetRecords(batch, records, resolvedBatchId, {
      referenceTime,
      timeWindowHours: profile.timeWindowHours,
    });
    const keptTweetIds = new Set(items.map((item) => item.tweetId));
    const tweetShapedRecords = filterTweetCsvRecords(records);
    const csvRecords = tweetShapedRecords.filter((record) => keptTweetIds.has(trimString(record.tweet_id ?? record.tweetId ?? record.id)));
    const responseClassification = classifyRawResponse(rawText, records.length);
    const coverage = summarizeBatchCoverage(batch, items, rowIssues, resolvedBatchId, null, responseClassification.classification);

    const result = {
      batchId: resolvedBatchId,
      seedIds: batch.map((seed) => seed.seedId),
      rawText,
      csvText,
      csvRecords,
      parseError: null,
      items,
      rowIssues,
      coverage,
      diagnostics,
      responseClassification,
      parserDiagnostics,
    };
    logger?.debug('fetch_batch_complete', {
      batchId: resolvedBatchId,
      seedCount: batch.length,
      itemCount: items.length,
      rowIssueCount: rowIssues.length,
      parseError: null,
      durationMs: Date.now() - startedAt,
      responseClassification: responseClassification?.classification ?? null,
      latencyMs: diagnostics?.latencyMs ?? null,
      parserStrategy: parserDiagnostics?.strategy ?? null,
      strictValidRecordCount: parserDiagnostics?.strict?.validIdentityCount ?? null,
      recoveredValidRecordCount: parserDiagnostics?.recovered?.validIdentityCount ?? null,
    });
    return result;
  } catch (error) {
    const responseClassification = classifyRawResponse(rawText, 0);
    const failure = summarizeRequestFailure(error);
    const result = {
      batchId: resolvedBatchId,
      seedIds: batch.map((seed) => seed.seedId),
      rawText,
      csvText: '',
      csvRecords: [],
      parseError: error.message,
      items: [],
      rowIssues: [],
      coverage: summarizeBatchCoverage(batch, [], [], resolvedBatchId, error.message, responseClassification.classification),
      diagnostics: failure.diagnostics,
      retryDiagnostics: failure.retryDiagnostics,
      responseClassification,
      parserDiagnostics: null,
    };
    logger?.warn('fetch_batch_failed', {
      attemptKind,
      round,
      batchId: resolvedBatchId,
      seedCount: batch.length,
      parseError: error?.message ?? String(error),
      durationMs: Date.now() - startedAt,
      responseClassification: responseClassification?.classification ?? null,
      errorClassification: failure.errorClassification,
      errorCode: failure.errorCode,
      httpStatus: failure.httpStatus,
      latencyMs: failure.latencyMs,
      targetHost: failure.targetHost,
      targetPath: failure.targetPath,
      retryAttempt: failure.retryAttempt,
      retryMaxAttempts: failure.retryMaxAttempts,
      retryExhausted: failure.retryExhausted,
    });
    return result;
  }
}

function uniqueByKey(items, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function resolveRefetchConfig(profile, effectiveConcurrency) {
  const statuses = Array.isArray(profile.refetchOnStatuses)
    ? profile.refetchOnStatuses.map((status) => trimString(status)).filter(Boolean)
    : [];
  const maxRounds = Math.max(0, Number(profile.refetchMaxRounds ?? 0) || 0);
  return {
    enabled: statuses.length > 0 && maxRounds > 0,
    statuses,
    maxRounds,
    batchSize: Math.max(1, Number(profile.refetchBatchSize ?? 1) || 1),
    concurrency: Math.max(1, Number(profile.refetchConcurrency ?? effectiveConcurrency ?? 1) || 1),
  };
}

function buildSeedActivityScore(seed) {
  const followersScore = Math.log10((seed.followersCount ?? 0) + 1) * 100;
  const postsScore = Math.log10((seed.postCount ?? 0) + 1) * 50;
  const favouritesScore = Math.log10((seed.totalFavouritesByUser ?? 0) + 1) * 10;
  const verifiedScore = seed.verified ? 100 : 0;
  const blueVerifiedScore = seed.isBlueVerified ? 40 : 0;
  return followersScore + postsScore + favouritesScore + verifiedScore + blueVerifiedScore;
}

function buildRefetchPriority(seed, outcome) {
  const account = outcome?.account ?? {};
  const rowIssues = Array.isArray(outcome?.rowIssues) ? outcome.rowIssues : [];
  const statusScore = account.status === 'incomplete'
    ? 100000
    : account.status === 'fetch_failed'
      ? 50000
      : account.status === 'soft_failed'
        ? 80000
        : account.status === 'no_tweets_found'
          ? 1000
          : 0;
  const outsideWindowScore = rowIssues.filter((issue) => issue.reason === OUTSIDE_TIME_WINDOW_REASON).length * 500;
  return statusScore + outsideWindowScore + buildSeedActivityScore(seed);
}

function orderSeedsForRefetch(seeds, outcomesBySeedId) {
  return [...seeds].sort((left, right) => {
    const leftOutcome = outcomesBySeedId.get(left.seedId);
    const rightOutcome = outcomesBySeedId.get(right.seedId);
    const scoreDelta = buildRefetchPriority(right, rightOutcome) - buildRefetchPriority(left, leftOutcome);
    if (scoreDelta !== 0) return scoreDelta;
    return left.csvRowNumber - right.csvRowNumber;
  });
}

async function executeSeedBatches({ seedBatches, promptTemplate, profile, fetchImpl, referenceTime, concurrency, attemptKind = 'initial', round = 0, batchIdBuilder, logger } = {}) {
  const batchResults = [];
  const startedAt = Date.now();
  const totalSeedCount = seedBatches.reduce((sum, batch) => sum + batch.length, 0);
  logger?.info('fetch_batches_start', {
    attemptKind,
    round,
    batchCount: seedBatches.length,
    totalSeedCount,
    concurrency,
  });
  for (let offset = 0; offset < seedBatches.length; offset += concurrency) {
    const window = seedBatches.slice(offset, offset + concurrency);
    const windowStartedAt = Date.now();
    const windowResults = await Promise.all(
      window.map((batch, index) => runSeedBatch({
        batch,
        batchIndex: offset + index,
        batchId: batchIdBuilder ? batchIdBuilder(offset + index) : undefined,
        promptTemplate,
        profile,
        fetchImpl,
        referenceTime,
        attemptKind,
        round,
        logger: logger?.child(`batch_${offset + index + 1}`),
      })),
    );
    batchResults.push(...windowResults.map((result) => ({ ...result, attemptKind, round })));
    logger?.debug('fetch_batch_window_complete', {
      attemptKind,
      round,
      offset,
      windowBatchCount: window.length,
      durationMs: Date.now() - windowStartedAt,
    });
  }
  logger?.info('fetch_batches_complete', {
    attemptKind,
    round,
    batchCount: batchResults.length,
    totalSeedCount,
    durationMs: Date.now() - startedAt,
  });
  return batchResults;
}

function buildSeedAttempt(seed, batchResult) {
  return {
    seedId: seed.seedId,
    batchId: batchResult.batchId,
    attemptKind: batchResult.attemptKind,
    round: batchResult.round,
    items: batchResult.items.filter((item) => item.source?.seedId === seed.seedId),
    rowIssues: batchResult.rowIssues.filter((issue) => issue.seedId === seed.seedId),
    parseError: batchResult.parseError,
    responseClassification: batchResult.responseClassification?.classification ?? null,
  };
}

function recordSeedAttempts(seedAttempts, seedById, batchResults) {
  for (const batchResult of batchResults) {
    for (const seedId of batchResult.seedIds) {
      const seed = seedById.get(seedId);
      if (!seed) continue;
      const attempts = seedAttempts.get(seedId);
      if (!attempts) continue;
      attempts.push(buildSeedAttempt(seed, batchResult));
    }
  }
}

function summarizeSeedAttempts(seed, attempts) {
  const uniqueItems = uniqueByKey(
    attempts.flatMap((attempt) => attempt.items),
    (item) => item.tweetId,
  );
  const uniqueRowIssues = uniqueByKey(
    attempts.flatMap((attempt) => attempt.rowIssues),
    (issue) => `${issue.batchId}|${issue.rowNumber}|${issue.seedId ?? ''}|${issue.reason}`,
  );
  const parseErrors = uniqueByKey(
    attempts.filter((attempt) => attempt.parseError).map((attempt) => ({ batchId: attempt.batchId, message: attempt.parseError })),
    (entry) => `${entry.batchId}|${entry.message}`,
  );
  const latestBatchId = attempts.at(-1)?.batchId ?? null;
  const allAttemptsFailed = attempts.length > 0 && attempts.every((attempt) => attempt.parseError);
  const softFailClassifications = new Set(['header_only', 'header_with_narrative', 'narrative_only', 'empty_response', 'unstructured']);
  const hasSoftFailClassification = attempts.some((attempt) => attempt.responseClassification && softFailClassifications.has(attempt.responseClassification));
  const issueNotes = uniqueRowIssues.map((issue) => `CSV row ${issue.rowNumber}: ${issue.reason}`);
  const { blockingIssues } = splitRowIssues(uniqueRowIssues);
  const blockingIssueNotes = blockingIssues.map((issue) => `CSV row ${issue.rowNumber}: ${issue.reason}`);

  let status = 'no_tweets_found';
  let notes = [];
  if (uniqueItems.length > 0) {
    status = blockingIssueNotes.length > 0 || parseErrors.length > 0 ? 'incomplete' : 'covered';
    notes = [...blockingIssueNotes, ...parseErrors.map((entry) => `Attempt ${entry.batchId}: ${entry.message}`)];
  } else if (issueNotes.length > 0) {
    status = 'incomplete';
    notes = [...issueNotes, ...parseErrors.map((entry) => `Attempt ${entry.batchId}: ${entry.message}`)];
  } else if (allAttemptsFailed && hasSoftFailClassification) {
    status = 'soft_failed';
    notes = parseErrors.map((entry) => entry.message);
  } else if (allAttemptsFailed) {
    status = 'fetch_failed';
    notes = parseErrors.map((entry) => entry.message);
  } else {
    status = 'no_tweets_found';
    notes = [NO_TWEET_NOTE];
  }

  return {
    seedId: seed.seedId,
    batchId: latestBatchId,
    items: uniqueItems,
    rowIssues: uniqueRowIssues,
    parseErrors,
      account: {
        seedId: seed.seedId,
        sourceTweetId: seed.sourceTweetId || null,
        handle: seed.handle,
        displayName: seed.displayName,
        userPageUrl: seed.userPageUrl,
        batchId: latestBatchId,
      status,
      tweetCount: uniqueItems.length,
      notes,
    },
  };
}

function buildCurrentOutcomes(seeds, seedAttempts) {
  return seeds.map((seed) => summarizeSeedAttempts(seed, seedAttempts.get(seed.seedId) ?? []));
}

function buildAccountObservability(seed, attempts, outcome) {
  const initialAttempts = attempts.filter((attempt) => attempt.attemptKind === 'initial');
  const refetchAttemptCount = attempts.filter((attempt) => attempt.attemptKind === 'refetch').length;
  const initialStatus = initialAttempts.length > 0
    ? summarizeSeedAttempts(seed, initialAttempts).account.status
    : outcome.account.status;
  const recoveredByRefetch = refetchAttemptCount > 0
    && initialStatus !== 'covered'
    && outcome.account.status === 'covered';

  return {
    ...outcome.account,
    initialStatus,
    wasRefetched: refetchAttemptCount > 0,
    refetchAttemptCount,
    recoveredByRefetch,
  };
}

function buildAccountSummary(account) {
  return {
    seedId: account.seedId,
    sourceTweetId: account.sourceTweetId ?? null,
    handle: account.handle,
    displayName: account.displayName,
    userPageUrl: account.userPageUrl,
    initialStatus: account.initialStatus,
    status: account.status,
    tweetCount: account.tweetCount,
    wasRefetched: account.wasRefetched,
    refetchAttemptCount: account.refetchAttemptCount,
    recoveredByRefetch: account.recoveredByRefetch,
    batchId: account.batchId,
  };
}

function buildRefetchObservability(seeds, seedAttempts, finalOutcomes) {
  const accounts = finalOutcomes.map((outcome) => {
    const seed = seeds.find((candidate) => candidate.seedId === outcome.seedId);
    return buildAccountObservability(seed ?? {}, seedAttempts.get(outcome.seedId) ?? [], outcome);
  });
  const recoveredAccounts = accounts.filter((account) => account.recoveredByRefetch).map(buildAccountSummary);
  const stayedNoTweetAccounts = accounts.filter((account) => account.status === 'no_tweets_found').map(buildAccountSummary);
  const stayedIncompleteAccounts = accounts.filter((account) => account.status === 'incomplete').map(buildAccountSummary);
  const stayedFailedAccounts = accounts.filter((account) => account.status === 'fetch_failed').map(buildAccountSummary);
  const stayedSoftFailedAccounts = accounts.filter((account) => account.status === 'soft_failed').map(buildAccountSummary);

  return {
    accounts,
    refetch: {
      recoveredAccounts,
      stayedNoTweetAccounts,
      stayedIncompleteAccounts,
      stayedFailedAccounts,
      stayedSoftFailedAccounts,
    },
    counts: {
      recoveredByRefetchCount: recoveredAccounts.length,
      stayedNoTweetAccountCount: stayedNoTweetAccounts.length,
      stayedIncompleteAccountCount: stayedIncompleteAccounts.length,
      stayedFailedAccountCount: stayedFailedAccounts.length,
      stayedSoftFailedAccountCount: stayedSoftFailedAccounts.length,
    },
  };
}

function buildCsvRecordFromItem(item) {
  return {
    username: item.username,
    tweet_id: item.tweetId,
    created_at: item.createdAt,
    text: item.text,
    original_url: item.originalUrl,
  };
}

function buildTweetIdentityIndexRecord(item) {
  return {
    TweetID: item.tweetId,
    UserPageURL: item.source?.userPageUrl ?? '',
    Handle: item.username,
    Name: item.displayName,
  };
}

function countByStatus(accounts, status) {
  return accounts.filter((account) => account.status === status).length;
}

function buildZeroPostDormantSeed(seed) {
  return {
    seedId: seed.seedId,
    sourceTweetId: seed.sourceTweetId || null,
    handle: seed.handle,
    displayName: seed.displayName,
    userPageUrl: seed.userPageUrl,
    postCount: seed.postCount,
    lastTweetDate: null,
    daysSinceLastTweet: null,
    dormantReason: 'zero_posts',
    status: 'dormant_skipped',
  };
}

function buildDormantAccountNote(entry) {
  if (entry.dormantReason === 'zero_posts') {
    return 'Dormant: skipped because seed CSV reports postCount=0.';
  }
  if (entry.lastTweetDate && Number.isFinite(entry.daysSinceLastTweet)) {
    return `Dormant: last tweet ${entry.lastTweetDate} (${entry.daysSinceLastTweet} days ago)`;
  }
  return 'Dormant: skipped by precheck.';
}

const PRECHECK_CSV_HEADER_RE = /(^|\n)\s*"?username"?\s*,\s*"?last_tweet_date"?/i;

function extractPrecheckCsvPayload(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '').trim();
  const candidates = [];
  const fenced = input.match(CSV_FENCE_RE);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(input);

  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').replace(/^\uFEFF/, '').trim();
    const match = normalized.match(PRECHECK_CSV_HEADER_RE);
    if (!match) continue;
    const prefixLength = match[1] ? match[1].length : 0;
    const startIndex = (match.index ?? 0) + prefixLength;
    return normalized.slice(startIndex).trim();
  }
  return null;
}

export async function runActivityPrecheck({ seeds, profile, fetchImpl, referenceTime, precheckConfig, logger } = {}) {
  const promptPath = resolveMaybeRelative(
    undefined,
    precheckConfig.promptFile,
  );
  let promptTemplate;
  try {
    promptTemplate = await readFile(promptPath, 'utf8');
  } catch {
    promptTemplate = await readFile(
      precheckConfig.promptFile.replace(/^\.\//, ''),
      'utf8',
    );
  }

  const batchSize = Math.max(1, Number(precheckConfig.batchSize ?? 10));
  const dormantThresholdDays = Math.max(1, Number(precheckConfig.dormantThresholdDays ?? 7));
  const timeoutMs = Number(precheckConfig.timeoutMs ?? 30000);
  const maxOutputTokens = Number(precheckConfig.maxOutputTokens ?? 500);
  const refTimeMs = referenceTime ? Date.parse(referenceTime) : Date.now();
  const thresholdMs = dormantThresholdDays * 24 * MS_PER_HOUR;

  const batches = chunkArray(seeds, batchSize);
  const precheckConcurrency = Math.max(1, Number(precheckConfig.concurrency ?? profile.concurrency ?? 1) || 1);
  const startedAt = Date.now();
  logger?.info('precheck_start', {
    seedCount: seeds.length,
    batchCount: batches.length,
    batchSize,
    dormantThresholdDays,
    concurrency: precheckConcurrency,
  });

  const batchResults = await mapWithConcurrency(batches, precheckConcurrency, async (batch) => {
    const handleList = batch.map((seed) => seed.handle).filter(Boolean).join(', ');
    const renderedPrompt = renderTemplate(promptTemplate, {
      SEED_COUNT: batch.length,
      HANDLE_LIST: handleList,
    });

    let rawText = '';
    const batchStartedAt = Date.now();
    try {
      const completion = await withRetry(
        () => postChatCompletions({
          baseUrl: profile.provider.baseUrl,
          apiKey: profile.provider.apiKey,
          apiProtocol: profile.provider.api ?? profile.apiProtocol,
          model: profile.model,
          timeoutMs,
          temperature: 0,
          maxTokens: maxOutputTokens,
          messages: [{ role: 'user', content: renderedPrompt }],
          fetchImpl,
          logger: logger?.child('llm'),
          operationName: `precheck:${handleList || 'batch'}`,
        }),
        profile.retry,
        { logger, operationName: `precheck:${handleList || 'batch'}` },
      );
      rawText = completion.text.trim();
    } catch (error) {
      const failure = summarizeRequestFailure(error);
      const rawResponse = {
        handles: batch.map((s) => s.handle),
        rawText,
        error: failure.diagnostics?.errorMessage ?? 'request_failed',
        diagnostics: failure.diagnostics,
        retryDiagnostics: failure.retryDiagnostics,
      };
      logger?.warn('precheck_batch_failed', {
        handleList,
        seedCount: batch.length,
        durationMs: Date.now() - batchStartedAt,
        error: failure.diagnostics?.errorMessage ?? 'request_failed',
        errorClassification: failure.errorClassification,
        errorCode: failure.errorCode,
        httpStatus: failure.httpStatus,
        latencyMs: failure.latencyMs,
        targetHost: failure.targetHost,
        targetPath: failure.targetPath,
        retryAttempt: failure.retryAttempt,
        retryMaxAttempts: failure.retryMaxAttempts,
        retryExhausted: failure.retryExhausted,
      });
      return {
        activeSeeds: batch,
        dormantSeeds: [],
        rawResponse,
      };
    }

    const rawResponse = {
      handles: batch.map((s) => s.handle),
      rawText,
      error: null,
      diagnostics: null,
      retryDiagnostics: null,
    };

    const csvPayload = extractPrecheckCsvPayload(rawText);
    if (!csvPayload) {
      logger?.debug('precheck_batch_no_csv', {
        handleList,
        seedCount: batch.length,
        durationMs: Date.now() - batchStartedAt,
      });
      return {
        activeSeeds: batch,
        dormantSeeds: [],
        rawResponse,
      };
    }

    const records = parseCsv(csvPayload);
    const lastTweetByHandle = new Map();
    for (const record of records) {
      const handle = trimString(record.username ?? record.handle ?? '').replace(/^@/, '');
      const dateStr = trimString(record.last_tweet_date ?? record.lastTweetDate ?? '');
      if (handle) lastTweetByHandle.set(handle.toLowerCase(), dateStr);
    }

    const activeSeeds = [];
    const dormantSeeds = [];
    for (const seed of batch) {
      const dateStr = lastTweetByHandle.get(seed.handle.toLowerCase());
      if (!dateStr) {
        activeSeeds.push(seed);
        continue;
      }
      const lastTweetMs = parseTimestampMs(dateStr);
      if (lastTweetMs === null) {
        activeSeeds.push(seed);
        continue;
      }
      const daysSinceLastTweet = (refTimeMs - lastTweetMs) / (24 * MS_PER_HOUR);
      if (daysSinceLastTweet > dormantThresholdDays) {
        dormantSeeds.push({
          seedId: seed.seedId,
          sourceTweetId: seed.sourceTweetId || null,
          handle: seed.handle,
          displayName: seed.displayName,
          userPageUrl: seed.userPageUrl,
          lastTweetDate: dateStr,
          daysSinceLastTweet: Math.round(daysSinceLastTweet * 10) / 10,
          status: 'dormant_skipped',
        });
      } else {
        activeSeeds.push(seed);
      }
    }
    logger?.debug('precheck_batch_complete', {
      handleList,
      seedCount: batch.length,
      durationMs: Date.now() - batchStartedAt,
    });
    return {
      activeSeeds,
      dormantSeeds,
      rawResponse,
    };
  });

  const activeSeeds = batchResults.flatMap((result) => result.activeSeeds);
  const dormantSeeds = batchResults.flatMap((result) => result.dormantSeeds);
  const rawResponses = batchResults.map((result) => result.rawResponse);

  logger?.info('precheck_complete', {
    seedCount: seeds.length,
    activeSeedCount: activeSeeds.length,
    dormantSeedCount: dormantSeeds.length,
    durationMs: Date.now() - startedAt,
  });
  return { activeSeeds, dormantSeeds, rawResponses };
}

export async function runFetch({ configPath, date, seedCsvPath, batchSize, fetchImpl, referenceTime, skipPrecheck } = {}) {
  const { config, skillRoot } = await loadConfig(configPath);
  const logger = createLogger({ level: config.defaults?.logLevel, scope: 'fetch' });
  const sourceDocs = await loadSourceDocuments(config, skillRoot);
  const profile = resolveFetchProfile(config, sourceDocs, config.fetch.activeProfile);
  const promptPath = resolveMaybeRelative(skillRoot, profile.promptFile);
  const promptTemplate = await readFile(promptPath, 'utf8');

  const effectiveSeedCsvPath = resolveMaybeRelative(skillRoot, seedCsvPath || profile.seedCsvPath);
  if (!effectiveSeedCsvPath) {
    throw new Error('Missing seedCsvPath in fetch profile or CLI options');
  }

  const seedCsvText = await readFile(effectiveSeedCsvPath, 'utf8');
  const seedRecords = parseCsv(seedCsvText);
  const seeds = normalizeSeedAccounts(seedRecords);
  if (seeds.length === 0) {
    throw new Error(`No seed accounts found in CSV: ${effectiveSeedCsvPath}`);
  }

  const effectiveBatchSize = Math.max(1, Number(batchSize ?? profile.batchSize ?? 10));
  const effectiveConcurrency = Math.max(1, Number(profile.concurrency ?? 1));
  const refetchConfig = resolveRefetchConfig(profile, effectiveConcurrency);
  const timeWindowHours = profile.timeWindowHours ?? 24;
  const runDate = resolveRunDate(date);
  const resolvedReferenceTime = resolveReferenceTime(referenceTime);
  const resolvedReferenceTimeMs = Date.parse(resolvedReferenceTime);
  const windowStartUtc = new Date(resolvedReferenceTimeMs - (timeWindowHours * MS_PER_HOUR)).toISOString();
  const windowEndUtc = new Date(resolvedReferenceTimeMs).toISOString();
  const runDir = await ensureRunDir(skillRoot, config.defaults.outputDir, runDate);
  const startedAt = Date.now();

  const precheckConfig = profile.precheck ?? {};
  const precheckEnabled = precheckConfig.enabled === true && !skipPrecheck;

  // Treat the static zero-post shortcut as part of precheck so --skip-precheck remains authoritative.
  const staticFilterEnabled = precheckEnabled && precheckConfig.staticFilterZeroPosts === true;
  const staticDormant = staticFilterEnabled
    ? seeds.filter((seed) => seed.postCount === 0).map(buildZeroPostDormantSeed)
    : [];
  const staticActive = staticFilterEnabled
    ? seeds.filter((seed) => seed.postCount !== 0)
    : seeds;

  let effectiveSeeds = staticActive;
  let dormantAccounts = staticDormant;
  let precheckRawResponses = [];
  logger.info('fetch_start', {
    runDate,
    seedCount: seeds.length,
    batchSize: effectiveBatchSize,
    concurrency: effectiveConcurrency,
    precheckEnabled,
    staticFilterZeroPosts: staticFilterEnabled,
    refetchEnabled: refetchConfig.enabled,
    refetchMaxRounds: refetchConfig.maxRounds,
  });

  if (precheckEnabled) {
    const precheckPromptPath = resolveMaybeRelative(skillRoot, precheckConfig.promptFile ?? 'assets/prompts/grok-precheck.txt');
    const resolvedPrecheckConfig = { ...precheckConfig, promptFile: precheckPromptPath };
    const precheckResult = await runActivityPrecheck({
      seeds: staticActive,
      profile,
      fetchImpl,
      referenceTime: resolvedReferenceTime,
      precheckConfig: resolvedPrecheckConfig,
      logger: logger.child('precheck'),
    });
    effectiveSeeds = precheckResult.activeSeeds;
    dormantAccounts = [...staticDormant, ...precheckResult.dormantSeeds];
    precheckRawResponses = precheckResult.rawResponses;
    logger.info('fetch_post_precheck', {
      activeSeedCount: effectiveSeeds.length,
      dormantSeedCount: dormantAccounts.length,
    });
  }

  const seedBatches = chunkArray(effectiveSeeds, effectiveBatchSize);
  const seedById = new Map(effectiveSeeds.map((seed) => [seed.seedId, seed]));
  const seedAttempts = new Map(effectiveSeeds.map((seed) => [seed.seedId, []]));

  const fetchInput = {
    task: {
      goal: 'Fetch the last 24 hours of X tweets from a local CSV roster via Grok',
      fetchProfile: profile.name,
      provider: profile.providerRef,
      model: profile.model,
      sourceCsvPath: effectiveSeedCsvPath,
      timeWindowHours,
      windowStartUtc,
      windowEndUtc,
      includeTweetTypes: profile.includeTweetTypes ?? ['original', 'repost', 'quote'],
      excludePureReplies: profile.excludePureReplies !== false,
      seedCount: seeds.length,
      activeSeedCount: effectiveSeeds.length,
      dormantSeedCount: dormantAccounts.length,
      precheckEnabled,
      batchSize: effectiveBatchSize,
      batchCount: seedBatches.length,
      refetchOnStatuses: refetchConfig.statuses,
      refetchMaxRounds: refetchConfig.maxRounds,
      refetchBatchSize: refetchConfig.batchSize,
      refetchConcurrency: refetchConfig.concurrency,
    },
    seeds,
    dormantAccounts,
  };
  const fetchInputPath = await writeJsonArtifact(runDir, config.runtime.artifacts.fetchInput, fetchInput);

  const executedBatchResults = await executeSeedBatches({
    seedBatches,
    promptTemplate,
    profile,
    fetchImpl,
    referenceTime: resolvedReferenceTime,
    concurrency: effectiveConcurrency,
    attemptKind: 'initial',
    round: 0,
    logger: logger.child('initial'),
  });
  recordSeedAttempts(seedAttempts, seedById, executedBatchResults);

  let currentOutcomes = buildCurrentOutcomes(effectiveSeeds, seedAttempts);
  let refetchRoundCount = 0;
  const refetchedSeedIds = new Set();

  if (refetchConfig.enabled) {
    const refetchStatusSet = new Set(refetchConfig.statuses);
    if (!refetchStatusSet.has('soft_failed')) refetchStatusSet.add('soft_failed');
    for (let round = 1; round <= refetchConfig.maxRounds; round += 1) {
      const outcomesBySeedId = new Map(currentOutcomes.map((outcome) => [outcome.seedId, outcome]));
      const seedsToRefetch = effectiveSeeds.filter((seed) => refetchStatusSet.has(outcomesBySeedId.get(seed.seedId)?.account.status));
      if (seedsToRefetch.length === 0) break;

      const orderedSeeds = orderSeedsForRefetch(seedsToRefetch, outcomesBySeedId);
      refetchRoundCount = round;
      for (const seed of orderedSeeds) refetchedSeedIds.add(seed.seedId);
      const roundStartedAt = Date.now();
      logger.info('fetch_refetch_round_start', {
        round,
        seedCount: orderedSeeds.length,
        batchSize: refetchConfig.batchSize,
        concurrency: refetchConfig.concurrency,
      });

      const refetchBatches = chunkArray(orderedSeeds, refetchConfig.batchSize);
      const refetchResults = await executeSeedBatches({
        seedBatches: refetchBatches,
        promptTemplate,
        profile,
        fetchImpl,
        referenceTime: resolvedReferenceTime,
        concurrency: refetchConfig.concurrency,
        attemptKind: 'refetch',
        round,
        batchIdBuilder: (index) => `refetch-r${round}-batch-${index + 1}`,
        logger: logger.child(`refetch_round_${round}`),
      });
      executedBatchResults.push(...refetchResults);
      recordSeedAttempts(seedAttempts, seedById, refetchResults);
      currentOutcomes = buildCurrentOutcomes(effectiveSeeds, seedAttempts);
      logger.info('fetch_refetch_round_complete', {
        round,
        seedCount: orderedSeeds.length,
        unresolvedSeedCount: currentOutcomes.filter((outcome) => refetchStatusSet.has(outcome.account.status)).length,
        durationMs: Date.now() - roundStartedAt,
      });
    }
  }

  const finalOutcomes = currentOutcomes;
  const observability = buildRefetchObservability(effectiveSeeds, seedAttempts, finalOutcomes);
  const accounts = [
    ...observability.accounts,
    ...dormantAccounts.map((entry) => ({
      seedId: entry.seedId,
      sourceTweetId: entry.sourceTweetId ?? null,
      handle: entry.handle,
      displayName: entry.displayName,
      userPageUrl: entry.userPageUrl,
      batchId: null,
      status: 'dormant_skipped',
      tweetCount: 0,
      notes: [buildDormantAccountNote(entry)],
      initialStatus: 'dormant_skipped',
      wasRefetched: false,
      refetchAttemptCount: 0,
      recoveredByRefetch: false,
      dormantReason: entry.dormantReason ?? null,
      lastTweetDate: entry.lastTweetDate,
      daysSinceLastTweet: entry.daysSinceLastTweet,
      })),
  ];
  const items = uniqueByKey(
    finalOutcomes.flatMap((outcome) => outcome.items),
    (item) => item.tweetId,
  );
  const batchLevelIssues = uniqueByKey(
    executedBatchResults.flatMap((result) => result.rowIssues.filter((issue) => !issue.seedId)),
    (issue) => `${issue.batchId}|${issue.rowNumber}|${issue.handle ?? ''}|${issue.reason}`,
  );
  const batchParseErrors = executedBatchResults
    .filter((result) => result.parseError)
    .map((result) => ({
      batchId: result.batchId,
      seedIds: result.seedIds,
      message: result.parseError,
    }));
  const parseErrors = uniqueByKey(
    finalOutcomes.flatMap((outcome) => outcome.parseErrors.map((entry) => ({ ...entry, seedId: outcome.seedId }))),
    (entry) => `${entry.batchId}|${entry.seedId}|${entry.message}`,
  );
  const warnings = uniqueByKey([
    ...batchParseErrors.map((entry) => ({
      type: 'batch_parse_error',
      batchId: entry.batchId,
      seedIds: entry.seedIds,
      message: entry.message,
    })),
    ...batchLevelIssues.map((issue) => ({
      type: 'unmatched_tweet_row',
      batchId: issue.batchId,
      rowNumber: issue.rowNumber,
      handle: issue.handle,
      message: issue.reason,
    })),
    ...finalOutcomes.flatMap((outcome) => outcome.rowIssues.filter((issue) => issue.reason === OUTSIDE_TIME_WINDOW_REASON).map((issue) => ({
      type: 'tweet_outside_time_window',
      batchId: issue.batchId,
      rowNumber: issue.rowNumber,
      seedId: issue.seedId,
      handle: issue.handle,
      message: issue.reason,
    }))),
  ], (warning) => JSON.stringify(warning));

  const fetchRawCsvText = serializeCsv(items.map((item) => buildCsvRecordFromItem(item)));
  const fetchRawCsvPath = await writeTextArtifact(
    runDir,
    config.runtime.artifacts.fetchRawCsv ?? 'fetch.raw.csv',
    fetchRawCsvText,
  );
  const tweetIdentityRows = uniqueByKey(
    items.map((item) => buildTweetIdentityIndexRecord(item)),
    (row) => row.TweetID,
  );
  const fetchTweetIndexCsvText = serializeCsv(
    tweetIdentityRows,
    ['TweetID', 'UserPageURL', 'Handle', 'Name'],
  );
  const fetchTweetIndexCsvPath = await writeTextArtifact(
    runDir,
    config.runtime.artifacts.fetchTweetIndexCsv ?? 'fetch.tweet-index.csv',
    fetchTweetIndexCsvText,
  );

  const fetchRaw = {
    meta: {
      sourceProvider: 'grok',
      capturedAt: resolvedReferenceTime,
      windowStartUtc,
      windowEndUtc,
      fetchInputPath,
      fetchRawCsvPath,
      fetchTweetIndexCsvPath,
      batchCount: executedBatchResults.length,
      initialBatchCount: seedBatches.length,
      refetchRoundCount,
      refetchedAccountCount: refetchedSeedIds.size,
      precheckActiveCount: effectiveSeeds.length,
      precheckDormantCount: dormantAccounts.length,
    },
    precheckRawResponses,
    batches: executedBatchResults.map((result) => ({
      batchId: result.batchId,
      attemptKind: result.attemptKind,
      round: result.round,
      seedIds: result.seedIds,
      parseError: result.parseError,
      rowCount: result.csvRecords.length,
      droppedOutsideWindowCount: countWindowDroppedRows(result.rowIssues),
      responseClassification: result.responseClassification?.classification ?? null,
      responseClassificationDetail: result.responseClassification?.detail ?? null,
      diagnostics: result.diagnostics ?? null,
      retryDiagnostics: result.retryDiagnostics ?? null,
      parserDiagnostics: result.parserDiagnostics ?? null,
      rawText: result.rawText,
    })),
  };
  const fetchRawPath = await writeJsonArtifact(runDir, config.runtime.artifacts.fetchRaw, fetchRaw);

  const fetchResult = {
      meta: {
        sourceProvider: 'grok',
        fetchedAt: resolvedReferenceTime,
        windowStartUtc,
        windowEndUtc,
        sourceCsvPath: effectiveSeedCsvPath,
        timeWindowHours,
        includeTweetTypes: profile.includeTweetTypes ?? ['original', 'repost', 'quote'],
        excludePureReplies: profile.excludePureReplies !== false,
        seedCount: seeds.length,
      activeSeedCount: effectiveSeeds.length,
      dormantSeedCount: dormantAccounts.length,
      precheckEnabled,
      precheckActiveCount: effectiveSeeds.length,
      precheckDormantCount: dormantAccounts.length,
      batchSize: effectiveBatchSize,
      batchCount: seedBatches.length,
      executedBatchCount: executedBatchResults.length,
      refetchRoundCount,
      refetchedAccountCount: refetchedSeedIds.size,
      tweetCount: items.length,
        fetchInputPath,
        fetchRawPath,
        fetchRawCsvPath,
        fetchTweetIndexCsvPath,
        parseErrorCount: batchParseErrors.length,
      coveredAccountCount: countByStatus(accounts, 'covered'),
      noTweetAccountCount: countByStatus(accounts, 'no_tweets_found'),
      failedAccountCount: countByStatus(accounts, 'fetch_failed'),
      softFailedAccountCount: countByStatus(accounts, 'soft_failed'),
      dormantSkippedAccountCount: countByStatus(accounts, 'dormant_skipped'),
      incompleteAccountCount: countByStatus(accounts, 'incomplete'),
      recoveredByRefetchCount: observability.counts.recoveredByRefetchCount,
      stayedNoTweetAccountCount: observability.counts.stayedNoTweetAccountCount,
        stayedIncompleteAccountCount: observability.counts.stayedIncompleteAccountCount,
        stayedFailedAccountCount: observability.counts.stayedFailedAccountCount,
        stayedSoftFailedAccountCount: observability.counts.stayedSoftFailedAccountCount,
        warningCount: warnings.length,
        durationMs: Date.now() - startedAt,
      },
    accounts,
    refetch: observability.refetch,
    items,
    warnings,
  };
  const fetchResultPath = await writeJsonArtifact(runDir, config.runtime.artifacts.fetchResult, fetchResult);
  const durationMs = Date.now() - startedAt;
  logger.info('fetch_complete', {
    runDate,
    activeSeedCount: effectiveSeeds.length,
    dormantSeedCount: dormantAccounts.length,
    tweetCount: items.length,
    coveredAccountCount: countByStatus(accounts, 'covered'),
    incompleteAccountCount: countByStatus(accounts, 'incomplete'),
    failedAccountCount: countByStatus(accounts, 'fetch_failed'),
    refetchRoundCount,
    durationMs,
  });

  return {
    runDir,
    fetchInputPath,
    fetchRawPath,
    fetchRawCsvPath,
    fetchTweetIndexCsvPath,
    fetchResultPath,
    seedCount: seeds.length,
    activeSeedCount: effectiveSeeds.length,
    dormantSeedCount: dormantAccounts.length,
    accountCount: accounts.length,
    tweetCount: items.length,
    parseErrorCount: batchParseErrors.length,
    failedAccountCount: countByStatus(accounts, 'fetch_failed'),
    softFailedAccountCount: countByStatus(accounts, 'soft_failed'),
    dormantSkippedAccountCount: countByStatus(accounts, 'dormant_skipped'),
    incompleteAccountCount: countByStatus(accounts, 'incomplete'),
    windowStartUtc,
    windowEndUtc,
    durationMs,
  };
}
