import { describe, expect, it } from 'vitest';
import { actionSchema } from './actions.js';

describe('computer-use action protocol', () => {
  it('accepts base primitives and typed browser extensions', () => {
    expect(actionSchema.parse({ type: 'click', x: 10, y: 20 })).toMatchObject({ type: 'click', button: 'left' });
    expect(actionSchema.parse({ type: 'extract-structured-dom', selector: 'main' })).toEqual({ type: 'extract-structured-dom', selector: 'main' });
    expect(() => actionSchema.parse({ type: 'click', x: '10', y: 20 })).toThrow();
  });
});
