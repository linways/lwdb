/**
 * Minimal structured logger. JSON on stderr, suitable for piping or scraping.
 * Uses level gating via config.logLevel. No deps.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let activeLevel = LEVELS.info;

export function setLogLevel(level) {
  activeLevel = LEVELS[level] ?? LEVELS.info;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < activeLevel) return;
  const entry = {
    t: new Date().toISOString(),
    lvl: level,
    msg,
    ...(fields && typeof fields === 'object' ? fields : {}),
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

export function child(scope) {
  return {
    debug: (msg, fields) => emit('debug', msg, { scope, ...(fields || {}) }),
    info: (msg, fields) => emit('info', msg, { scope, ...(fields || {}) }),
    warn: (msg, fields) => emit('warn', msg, { scope, ...(fields || {}) }),
    error: (msg, fields) => emit('error', msg, { scope, ...(fields || {}) }),
  };
}
