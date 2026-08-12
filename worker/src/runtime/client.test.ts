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
        needsInput: async () => undefined,
        getInput: async () => undefined
      },
      planner: { plan: async (_task, last) => last === undefined ? { type: 'action', action: { type: 'screenshot' } } : { type: 'done', findings: [] } },
      executor: { execute: async (action) => { calls.push(action.type); return {}; }, close: async () => { calls.push('close'); } }
    });
    await runtime.runOnce();
    expect(calls).toEqual(['screenshot', 'completed', 'close']);
  });

  it('reports executor failures and masks handoff actions', async () => {
    const calls: boolean[] = [];
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x' }, leaseToken: 'lease_1' }),
        heartbeat: async () => undefined,
        result: async (_id, _token, status) => { expect(status).toBe('failed'); },
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined
      },
      planner: { plan: async () => ({ type: 'action', action: { type: 'wait', milliseconds: 0 } }) },
      executor: { execute: async (_action, context) => { calls.push(context.masking); if (!context.masking) throw new Error('boom'); return {}; }, close: async () => undefined }
    });
    await runtime.runOnce();
    await runtime.executeHandoff('task_1', { type: 'screenshot' });
    expect(calls).toEqual([false, true]);
  });

  it('signals needs input, polls, and resumes the planner', async () => {
    const calls: string[] = [];
    let input: unknown;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x' }, leaseToken: 'lease_1' }),
        heartbeat: async () => undefined,
        result: async (_id, _token, status) => { calls.push(status); },
        artifact: async () => undefined,
        needsInput: async () => { calls.push('needs_input'); },
        getInput: async () => input
      },
      planner: {
        plan: async (_task, last) => last === undefined ? { type: 'needs_input', kind: 'text' } : { type: 'done', findings: [last] }
      },
      executor: { execute: async () => { calls.push('execute'); return {}; }, close: async () => undefined }
    });
    setTimeout(() => { input = { kind: 'text', value: 'later' }; }, 30);
    await runtime.runOnce();
    expect(calls).toEqual(['needs_input', 'completed']);
  });

  it('swallows rejected heartbeat promises through the logger hook', async () => {
    const warnings: string[] = [];
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x' }, leaseToken: 'lease_1' }),
        heartbeat: async () => { throw new Error('heartbeat down'); },
        result: async () => undefined,
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined
      },
      planner: { plan: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { type: 'done', findings: [] };
      } },
      heartbeatMs: 1,
      logger: { warn: (message) => warnings.push(message), error: () => undefined },
      executor: { execute: async () => ({}), close: async () => undefined }
    });
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(warnings).toContain('lease heartbeat failed');
  });

  it('stops the planner when heartbeat discovers cancellation', async () => {
    let closed = false;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x' }, leaseToken: 'lease_1' }),
        heartbeat: async () => { throw Object.assign(new Error('cancelled'), { code: 'task_cancelled' }); },
        result: async () => undefined,
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined
      },
      heartbeatMs: 1,
      planner: { plan: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { type: 'action', action: { type: 'wait', milliseconds: 0 } };
      } },
      executor: { execute: async () => ({}), close: async () => { closed = true; } }
    });
    await runtime.runOnce();
    expect(closed).toBe(true);
  });
});
