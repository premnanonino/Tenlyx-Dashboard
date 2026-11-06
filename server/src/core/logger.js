const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, scope, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, scope, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export function createLogger(scope = 'app') {
  return {
    debug: (msg, f) => emit('debug', scope, msg, f),
    info: (msg, f) => emit('info', scope, msg, f),
    warn: (msg, f) => emit('warn', scope, msg, f),
    error: (msg, f) => emit('error', scope, msg, f),
    child: (sub) => createLogger(`${scope}.${sub}`),
  };
}
