import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(THIS_DIR, '..');
const DEFAULT_CONFIG_PATH = resolve(SKILL_ROOT, 'config.json');

export function expandHomePath(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return value;
    return resolve(home, value.slice(2));
  }
  return value;
}

export function resolveMaybeRelative(baseDir, value) {
  const expanded = expandHomePath(value);
  if (!expanded || typeof expanded !== 'string') return expanded;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export async function readJsonFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export function resolveJsonPath(root, jsonPath) {
  if (!jsonPath || jsonPath === '$') return root;
  const normalized = jsonPath.startsWith('$.') ? jsonPath.slice(2) : jsonPath.startsWith('$') ? jsonPath.slice(1) : jsonPath;
  if (!normalized) return root;
  return normalized.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), root);
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const absolutePath = resolveMaybeRelative(process.cwd(), configPath);
  const config = await readJsonFile(absolutePath);
  return { config, configPath: absolutePath, skillRoot: dirname(absolutePath) };
}

export async function loadSourceDocuments(config, skillRoot) {
  const entries = Object.entries(config?.sources?.credentialFiles ?? {});
  const docs = {};
  for (const [key, sourcePath] of entries) {
    const absolutePath = resolveMaybeRelative(skillRoot, sourcePath);
    docs[key] = {
      path: absolutePath,
      json: await readJsonFile(absolutePath),
    };
  }
  return docs;
}
