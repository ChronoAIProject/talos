import { describe, expect, it } from 'vitest';
import { TESTING_PUBLIC_ERROR_CATALOG, publicErrorRetryable } from './errors.js';

describe('public error classification', () => {
  it('keeps Testing Tool retryability stable and defaults unknown server failures safely', () => {
    expect(TESTING_PUBLIC_ERROR_CATALOG.testing_placement_unavailable).toEqual({
      classification: 'no_eligible_machine',
      retryable: true
    });
    expect(TESTING_PUBLIC_ERROR_CATALOG.stale_testing_machine.retryable).toBe(false);
    expect(TESTING_PUBLIC_ERROR_CATALOG.terminal_commit_conflict.retryable).toBe(false);
    expect(publicErrorRetryable('cursor_expired', 410)).toBe(true);
    expect(publicErrorRetryable('unknown_client_conflict', 409)).toBe(false);
    expect(publicErrorRetryable('internal_error', 500)).toBe(true);
  });
});
