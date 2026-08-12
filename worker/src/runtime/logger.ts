import type { RuntimeLogger } from './client.js';

type Level = 'warn' | 'error';

export const createWorkerLogger = (): RuntimeLogger => {
  const write = (level: Level, message: string, fields?: Record<string, unknown>): void => {
    process.stderr.write(JSON.stringify({ level, message, ...fields }) + '\n');
  };
  return {
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields)
  };
};
