import { describe, expect, it } from 'vitest';
import { WorkerRuntime } from './client.js';

describe('WorkerRuntime', () => {
  it('relays actions and reports completion', async () => {
    const calls: string[] = [];
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x' }, leaseToken: 'lease_1' }),
        heartbeat: async () => undefined,
        result: async (_id, _token, status) => { calls.push(status); },
        artifact: async () => undefined,
        input: async () => undefined
      },
      executor: { execute: async (action) => { calls.push(action.type); }, close: async () => { calls.push('close'); } }
    });
    await runtime.runOnce([{ type: 'screenshot' }, { type: 'wait', milliseconds: 0 }]);
    expect(calls).toEqual(['screenshot', 'wait', 'completed', 'close']);
  });

  it('reports executor failures and masks handoff actions', async () => {
    const calls: boolean[] = [];
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x' }, leaseToken: 'lease_1' }),
        heartbeat: async () => undefined,
        result: async (_id, _token, status) => { expect(status).toBe('failed'); },
        artifact: async () => undefined,
        input: async () => undefined
      },
      executor: { execute: async (_action, context) => { calls.push(context.masking); if (context.masking) return; throw new Error('boom'); }, close: async () => undefined }
    });
    await runtime.runOnce([{ type: 'wait', milliseconds: 0 }]);
    await runtime.executeHandoff('task_1', { type: 'screenshot' });
    expect(calls).toEqual([false, true]);
  });
});
