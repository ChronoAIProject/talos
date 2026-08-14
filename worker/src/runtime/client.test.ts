import { describe, expect, it } from 'vitest';
import type { Executor } from '../executor/executor.js';
import { WorkerRuntime } from './client.js';
import { WorkerClientError } from './errors.js';

const executorFactory = (executor: Executor) => async () => executor;

describe('WorkerRuntime', () => {
  it('relays actions and reports completion', async () => {
    const calls: string[] = [];
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x', interaction: 'autonomous' as const }, leaseToken: 'lease_1' }),
        heartbeat: async () => ({ status: 'running' as const }),
        result: async (_id, _token, status) => { calls.push(status); },
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => ({ closing: false }),
        actionResult: async () => undefined
      },
      planner: { plan: async (_task, last) => last === undefined ? { type: 'action', action: { type: 'screenshot' } } : { type: 'done', findings: [] } },
      createExecutor: executorFactory({ execute: async (action) => { calls.push(action.type); return {}; }, close: async () => { calls.push('close'); } })
    });
    await runtime.runOnce();
    expect(calls).toEqual(['screenshot', 'completed', 'close']);
  });

  it('reports executor failures', async () => {
    const calls: boolean[] = [];
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x', interaction: 'autonomous' as const }, leaseToken: 'lease_1' }),
        heartbeat: async () => ({ status: 'running' as const }),
        result: async (_id, _token, status) => { expect(status).toBe('failed'); },
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => ({ closing: false }),
        actionResult: async () => undefined
      },
      planner: { plan: async () => ({ type: 'action', action: { type: 'wait', milliseconds: 0 } }) },
      createExecutor: executorFactory({ execute: async (_action, context) => { calls.push(context.masking); if (!context.masking) throw new Error('boom'); return {}; }, close: async () => undefined })
    });
    await runtime.runOnce();
    expect(calls).toEqual([false]);
  });

  it('signals needs input, polls, and resumes the planner', async () => {
    const calls: string[] = [];
    let input: unknown;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x', interaction: 'autonomous' as const }, leaseToken: 'lease_1' }),
        heartbeat: async () => ({ status: 'running' as const }),
        result: async (_id, _token, status) => { calls.push(status); },
        artifact: async () => undefined,
        needsInput: async () => { calls.push('needs_input'); },
        getInput: async () => input,
        pollAction: async () => ({ closing: false }),
        actionResult: async () => undefined
      },
      planner: {
        plan: async (_task, last) => last === undefined ? { type: 'needs_input', kind: 'text' } : { type: 'done', findings: [last] }
      },
      inputPollMs: 1,
      createExecutor: executorFactory({ execute: async () => { calls.push('execute'); return {}; }, close: async () => undefined })
    });
    setTimeout(() => { input = { kind: 'text', value: 'later' }; }, 30);
    await runtime.runOnce();
    expect(calls).toEqual(['needs_input', 'completed']);
  });

  it('swallows rejected heartbeat promises through the logger hook', async () => {
    const warnings: string[] = [];
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x', interaction: 'autonomous' as const }, leaseToken: 'lease_1' }),
        heartbeat: async () => { throw new Error('heartbeat down'); },
        result: async () => undefined,
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => ({ closing: false }),
        actionResult: async () => undefined
      },
      planner: { plan: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { type: 'done', findings: [] };
      } },
      heartbeatMs: 1,
      inputPollMs: 1,
      logger: { warn: (message) => warnings.push(message), error: () => undefined },
      createExecutor: executorFactory({ execute: async () => ({}), close: async () => undefined })
    });
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(warnings).toContain('lease heartbeat failed');
  });

  it('waits for an in-flight heartbeat before closing the executor', async () => {
    const calls: string[] = [];
    let releaseHeartbeat: (() => void) | undefined;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x', interaction: 'autonomous' as const }, leaseToken: 'lease_1' }),
        heartbeat: async () => {
          calls.push('heartbeat-start');
          await new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
          calls.push('heartbeat-end');
          return { status: 'running' as const };
        },
        result: async () => { calls.push('result'); },
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => ({ closing: false }),
        actionResult: async () => undefined
      },
      heartbeatMs: 1,
      planner: { plan: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { type: 'done', findings: [] };
      } },
      createExecutor: executorFactory({ execute: async () => ({}), close: async () => { calls.push('close'); } })
    });

    const running = runtime.runOnce();
    while (releaseHeartbeat === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((call) => call === 'heartbeat-start')).toHaveLength(1);
    releaseHeartbeat();
    await running;
    expect(calls.slice(-2)).toEqual(['heartbeat-end', 'close']);
  });

  it('stops the planner when heartbeat discovers cancellation', async () => {
    let closed = false;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x', interaction: 'autonomous' as const }, leaseToken: 'lease_1' }),
        heartbeat: async () => { throw new WorkerClientError('task_cancelled', 'cancelled', 409); },
        result: async () => undefined,
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => ({ closing: false }),
        actionResult: async () => undefined
      },
      heartbeatMs: 1,
      inputPollMs: 1,
      planner: { plan: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { type: 'action', action: { type: 'wait', milliseconds: 0 } };
      } },
      createExecutor: executorFactory({ execute: async () => ({}), close: async () => { closed = true; } })
    });
    await runtime.runOnce();
    expect(closed).toBe(true);
  });

  it('pauses actions during heartbeat handoff and resumes afterward', async () => {
    const actions: string[] = [];
    let heartbeats = 0;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({ task: { id: 'task_1', kind: 'browse', goal: 'x', interaction: 'autonomous' as const }, leaseToken: 'lease_1' }),
        heartbeat: async () => ({ status: heartbeats++ < 2 ? 'handoff' as const : 'running' as const }),
        result: async () => undefined,
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => ({ closing: false }),
        actionResult: async () => undefined
      },
      heartbeatMs: 1,
      inputPollMs: 1,
      planner: { plan: async (_task, last) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return last === undefined
          ? { type: 'action', action: { type: 'wait', milliseconds: 0 } }
          : { type: 'done', findings: [] };
      } },
      createExecutor: executorFactory({
        execute: async (action) => {
          actions.push(action.type);
          return {};
        },
        close: async () => undefined
      })
    });
    await runtime.runOnce();
    expect(heartbeats).toBeGreaterThanOrEqual(3);
    expect(actions).toEqual(['wait']);
  });

  it('runs interactive actions without invoking the planner and closes on request', async () => {
    const calls: string[] = [];
    let polls = 0;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({
          task: { id: 'session_1', kind: 'browse', goal: 'interactive', interaction: 'interactive' as const },
          leaseToken: 'lease_1'
        }),
        heartbeat: async () => ({ status: 'running' as const }),
        result: async (_id, _token, status) => { calls.push(status); },
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => polls++ === 0
          ? { closing: false, action: { id: 'action_1', action: { type: 'navigate' as const, url: 'https://example.com' } } }
          : { closing: true },
        actionResult: async (_taskId, actionId) => { calls.push(actionId); }
      },
      planner: { plan: async () => { throw new Error('planner must not run'); } },
      createExecutor: executorFactory({
        execute: async (action) => { calls.push(action.type); return { value: 'ok' }; },
        close: async () => { calls.push('close'); }
      }),
      actionPollMs: 1
    });

    await runtime.runOnce();
    expect(calls).toEqual(['navigate', 'action_1', 'completed', 'close']);
  });

  it('fails an interactive session after its idle timeout', async () => {
    const calls: Array<{ status: string; code?: string }> = [];
    let now = 0;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({
          task: { id: 'session_1', kind: 'browse', goal: 'interactive', interaction: 'interactive' as const },
          leaseToken: 'lease_1'
        }),
        heartbeat: async () => ({ status: 'running' as const }),
        result: async (_id, _token, status, _findings, error) => { calls.push({ status, code: error?.code }); },
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => ({ closing: false }),
        actionResult: async () => undefined
      },
      planner: { plan: async () => { throw new Error('planner must not run'); } },
      createExecutor: executorFactory({ execute: async () => ({}), close: async () => undefined }),
      clock: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      actionPollMs: 250,
      sessionIdleMs: 500
    });

    await runtime.runOnce();
    expect(calls).toEqual([{ status: 'failed', code: 'session_idle_timeout' }]);
  });

  it('resolves the current interactive action when execution fails', async () => {
    const calls: Array<{ kind: string; code?: string }> = [];
    let polls = 0;
    const runtime = new WorkerRuntime({
      client: {
        claim: async () => ({
          task: { id: 'session_1', kind: 'browse', goal: 'interactive', interaction: 'interactive' as const },
          leaseToken: 'lease_1'
        }),
        heartbeat: async () => ({ status: 'running' as const }),
        result: async (_id, _token, status, _findings, error) => { calls.push({ kind: status, code: error?.code }); },
        artifact: async () => undefined,
        needsInput: async () => undefined,
        getInput: async () => undefined,
        pollAction: async () => polls++ === 0
          ? { closing: false, action: { id: 'action_1', action: { type: 'click' as const, x: 1, y: 1, button: 'left' as const } } }
          : { closing: false },
        actionResult: async (_taskId, _actionId, _token, result) => {
          calls.push({ kind: 'action', code: (result as { error?: { code?: string } }).error?.code });
        }
      },
      planner: { plan: async () => { throw new Error('planner must not run'); } },
      createExecutor: executorFactory({ execute: async () => { throw new Error('click failed'); }, close: async () => undefined })
    });

    await runtime.runOnce();
    expect(calls).toEqual([
      { kind: 'action', code: 'executor_failed' },
      { kind: 'failed', code: 'executor_failed' }
    ]);
  });
});
