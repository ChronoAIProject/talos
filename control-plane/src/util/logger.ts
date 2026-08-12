export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const createLogger = (): Logger => ({
  info: (message, fields) => process.env.TALOS_LOG_LEVEL === 'debug' && process.stderr.write(JSON.stringify({ level: 'info', message, ...fields }) + '\n'),
  warn: (message, fields) => process.stderr.write(JSON.stringify({ level: 'warn', message, ...fields }) + '\n'),
  error: (message, fields) => process.stderr.write(JSON.stringify({ level: 'error', message, ...fields }) + '\n')
});
