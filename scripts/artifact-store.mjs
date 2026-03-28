import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

function formatRunDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function resolveRunDate(input = new Date()) {
  if (typeof input === 'string') {
    const normalized = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
    if (normalized.length === 0) return formatRunDate(new Date());
  }

  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid run date: ${String(input)}`);
  }
  return formatRunDate(date);
}

function generateRunId() {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `run-${hh}${mm}${ss}`;
}

export async function ensureRunDir(skillRoot, outputDir, runDate) {
  const runId = generateRunId();
  const dir = resolve(skillRoot, outputDir, runDate, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function findLatestRunDir(skillRoot, outputDir, runDate) {
  const dateDir = resolve(skillRoot, outputDir, runDate);
  try {
    const entries = await readdir(dateDir);
    const runDirs = entries.filter((entry) => entry.startsWith('run-')).sort();
    if (runDirs.length === 0) return dateDir;
    return resolve(dateDir, runDirs[runDirs.length - 1]);
  } catch {
    return dateDir;
  }
}

export async function writeJsonArtifact(runDir, fileName, value) {
  const filePath = resolve(runDir, fileName);
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
  return filePath;
}

export async function writeTextArtifact(runDir, fileName, value) {
  const filePath = resolve(runDir, fileName);
  await writeFile(filePath, value, 'utf8');
  return filePath;
}

export async function readJsonArtifact(runDir, fileName) {
  const filePath = resolve(runDir, fileName);
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}
