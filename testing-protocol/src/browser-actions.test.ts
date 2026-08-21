import { describe, expect, it } from 'vitest';
import { browserActionSchema } from './browser-actions.js';

describe('browser action protocol', () => {
  it('normalizes optional browser action fields consistently', () => {
    expect(browserActionSchema.parse({ type: 'screenshot' })).toEqual({
      type: 'screenshot',
      format: 'jpeg',
      quality: 70
    });
    expect(browserActionSchema.parse({ type: 'click', x: 10, y: 20 })).toMatchObject({ button: 'left' });
    expect(browserActionSchema.parse({ type: 'scroll', deltaY: 5 })).toMatchObject({ deltaX: 0 });
  });

  it('rejects invalid action payloads', () => {
    expect(() => browserActionSchema.parse({ type: 'click', x: '10', y: 20 })).toThrow();
    expect(() => browserActionSchema.parse({ type: 'wait', milliseconds: 60001 })).toThrow();
    expect(() => browserActionSchema.parse({ type: 'navigate', url: 'not-a-url' })).toThrow();
  });
});
