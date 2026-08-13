import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';

describe('logger levels', () => {
  it('uses normal severity ordering', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createLogger('info');
    logger.error('e'); logger.warn('w'); logger.info('i'); logger.debug('d');
    expect(write).toHaveBeenCalledTimes(3);
    write.mockRestore();
  });

  it('supports debug and falls back from unknown levels', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createLogger('debug').debug('d');
    createLogger('unknown').info('i');
    expect(write).toHaveBeenCalledTimes(2);
    write.mockRestore();
  });
});
