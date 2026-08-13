import { describe, expect, it } from 'vitest';
import { createHandoffPolicy } from './policy.js';

describe('handoff policy', () => {
  it('switches masking immutably', () => {
    const policy = createHandoffPolicy();
    const masked = policy.startHandoff();
    expect(policy.isMasked).toBe(false);
    expect(masked.isMasked).toBe(true);
    expect(masked.endHandoff().isMasked).toBe(false);
  });
});
