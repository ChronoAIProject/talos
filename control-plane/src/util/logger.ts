export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

type Level = 'error' | 'warn' | 'info' | 'debug';
const rank: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export const createLogger = (configured = process.env.TALOS_LOG_LEVEL ?? 'info'): Logger => {
  const minimum: Level = configured in rank ? configured as Level : 'info';
  const write = (level: Level, message: string, fields?: Record<string, unknown>): void => {
    if (rank[level] <= rank[minimum]) process.stderr.write(JSON.stringify({ level, message, ...fields }) + '\n');
  };
  return {
    error: (message, fields) => write('error', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    info: (message, fields) => write('info', message, fields),
    debug: (message, fields) => write('debug', message, fields)
  };
};
