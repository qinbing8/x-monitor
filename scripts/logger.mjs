const LOG_LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function normalizeLogLevel(level) {
  const normalized = typeof level === 'string' ? level.trim().toLowerCase() : '';
  return Object.hasOwn(LOG_LEVEL_PRIORITY, normalized) ? normalized : 'info';
}

function shouldLog(currentLevel, entryLevel) {
  return LOG_LEVEL_PRIORITY[entryLevel] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function sanitizeFields(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

export function createLogger({ level = 'info', scope = 'app' } = {}) {
  const normalizedLevel = normalizeLogLevel(level);

  function write(entryLevel, event, fields = {}) {
    if (!shouldLog(normalizedLevel, entryLevel)) return;
    const payload = sanitizeFields({
      timestamp: new Date().toISOString(),
      level: entryLevel,
      scope,
      event,
      ...fields,
    });
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    level: normalizedLevel,
    scope,
    child(childScope) {
      const nextScope = childScope ? `${scope}.${childScope}` : scope;
      return createLogger({ level: normalizedLevel, scope: nextScope });
    },
    debug(event, fields) {
      write('debug', event, fields);
    },
    info(event, fields) {
      write('info', event, fields);
    },
    warn(event, fields) {
      write('warn', event, fields);
    },
    error(event, fields) {
      write('error', event, fields);
    },
  };
}
