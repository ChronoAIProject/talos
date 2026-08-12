import { describe, expect, it } from 'vitest';
import { createControlPlane } from './index.js';

describe('control-plane factory', () => {
  it('wires a stoppable lease sweep', () => {
    const server = createControlPlane(undefined, 'webhook-secret-1234', { sweepIntervalMs: 100000, adminToken: 'admin-token-123456' });
    expect(typeof server.stopSweep).toBe('function');
    server.stopSweep();
  });

  it('fails fast without a webhook secret', () => {
    expect(() => createControlPlane(undefined, undefined)).toThrow('TALOS_WEBHOOK_SECRET');
  });
});
