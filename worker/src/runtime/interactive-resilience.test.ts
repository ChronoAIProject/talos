import { describe, expect, it } from 'vitest';
import type { Executor } from '../executor/executor.js';
import type { WorkerClient } from './client.js';
import { WorkerRuntime } from './client.js';
import { WorkerClientError } from './errors.js';

const interactiveClaim = async () => ({
  task: {
    id: 'session_1',
    kind: 'browse' as const,
    goal: 'interactive',
    interaction: 'interactive' as const
  },
  leaseToken: 'lease_1'
});

const clientWith = (overrides: Partial<WorkerClient>): WorkerClient => ({
  claim: interactiveClaim,
  heartbeat: async () => ({ status: 'running' }),
  result: async () => undefined,
  artifact: async () => undefined,
  needsInput: async () => undefined,
  getInput: async () => undefined,
  pollAction: async () => ({ closing: true }),
  actionResult: async () => undefined,
  ...overrides
});

const planner = {
  plan: async () => {
    throw new Error('planner must not run');
  }
};

const executorFactory = (executor: Executor) => async () => executor;

describe('interactive worker resilience', () => {
  it('backs off after rate-limited polls and then executes the action', async () => {
    const sleeps: number[] = [];
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const actions: string[] = [];
    let polls = 0;
    const runtime = new WorkerRuntime({
      client: clientWith({
        pollAction: async () => {
          polls += 1;
          if (polls <= 2) {
            throw new WorkerClientError('rate_limited', 'slow down', 429);
          }
          if (polls === 3) {
            return {
              closing: false,
              action: { id: 'action_1', action: { type: 'wait', milliseconds: 1 } }
            };
          }
          return { closing: true };
        },
        actionResult: async (_taskId, actionId) => {
          actions.push(actionId);
        }
      }),
      planner,
      createExecutor: executorFactory({
        execute: async (action) => {
          actions.push(action.type);
          return { value: 'ok' };
        },
        close: async () => undefined
      }),
      logger: {
        warn: (_message, fields) => warnings.push(fields),
        error: () => undefined
      },
      actionPollMs: 100,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    await runtime.runOnce();

    expect(sleeps).toEqual([100, 200]);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatchObject({ status: 429, retryInMs: 200, pollIntervalMs: 225 });
    expect(actions).toEqual(['wait', 'action_1']);
  });

  it('retries a network-level action poll failure', async () => {
    const sleeps: number[] = [];
    let polls = 0;
    const runtime = new WorkerRuntime({
      client: clientWith({
        pollAction: async () => {
          polls += 1;
          if (polls === 1) throw new TypeError('fetch failed');
          return { closing: true };
        }
      }),
      planner,
      createExecutor: executorFactory({ execute: async () => ({}), close: async () => undefined }),
      actionPollMs: 50,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    await runtime.runOnce();

    expect(polls).toBe(2);
    expect(sleeps).toEqual([50]);
  });

  it('fails the session on an authentication error without retrying', async () => {
    const statuses: string[] = [];
    let polls = 0;
    const runtime = new WorkerRuntime({
      client: clientWith({
        pollAction: async () => {
          polls += 1;
          throw new WorkerClientError('unauthorized', 'invalid worker credentials', 401);
        },
        result: async (_taskId, _leaseToken, status) => {
          statuses.push(status);
        }
      }),
      planner,
      createExecutor: executorFactory({ execute: async () => ({}), close: async () => undefined }),
      actionPollMs: 50,
      sleep: async () => {
        throw new Error('authentication failures must not sleep');
      }
    });

    await runtime.runOnce();

    expect(polls).toBe(1);
    expect(statuses).toEqual(['failed']);
  });

  it('retries result submission without executing the browser action twice', async () => {
    const sleeps: number[] = [];
    const results: unknown[] = [];
    let polls = 0;
    let executions = 0;
    const runtime = new WorkerRuntime({
      client: clientWith({
        pollAction: async () => {
          polls += 1;
          return polls === 1
            ? {
                closing: false,
                action: { id: 'action_1', action: { type: 'screenshot' } }
              }
            : { closing: true };
        },
        actionResult: async (_taskId, _actionId, _leaseToken, result) => {
          results.push(result);
          if (results.length === 1) {
            throw new WorkerClientError('upstream_error', 'temporarily unavailable', 503);
          }
        }
      }),
      planner,
      createExecutor: executorFactory({
        execute: async () => {
          executions += 1;
          return { value: 'image' };
        },
        close: async () => undefined
      }),
      actionPollMs: 75,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    await runtime.runOnce();

    expect(executions).toBe(1);
    expect(results).toEqual([{ value: 'image' }, { value: 'image' }]);
    expect(sleeps).toEqual([75]);
  });

  it('accepts the duplicate-result conflict after a lost success response', async () => {
    let polls = 0;
    let submissions = 0;
    const statuses: string[] = [];
    const runtime = new WorkerRuntime({
      client: clientWith({
        pollAction: async () => {
          polls += 1;
          return polls === 1
            ? {
                closing: false,
                action: { id: 'action_1', action: { type: 'wait', milliseconds: 1 } }
              }
            : { closing: true };
        },
        actionResult: async () => {
          submissions += 1;
          throw new WorkerClientError(
            'action_already_completed',
            'session action result was already stored',
            409
          );
        },
        result: async (_taskId, _leaseToken, status) => {
          statuses.push(status);
        }
      }),
      planner,
      createExecutor: executorFactory({ execute: async () => ({ value: 'ok' }), close: async () => undefined }),
      actionPollMs: 50
    });

    await runtime.runOnce();

    expect(submissions).toBe(1);
    expect(statuses).toEqual(['completed']);
  });
});
