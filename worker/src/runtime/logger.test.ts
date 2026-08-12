import { describe, expect, it, vi } from 'vitest';
import { createWorkerLogger } from './logger.js';

describe('worker logger', () => {
  it('writes structured warnings and errors', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createWorkerLogger();
    logger.warn('retrying', { attempt: 2 });
    logger.error('stopped');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.[0]).toContain('"attempt":2');
    write.mockRestore();
  });
});
