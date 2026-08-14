import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserExecutorFactory } from '../executor/browser-executor-factory.js';
import type { TaskEnvelope, WorkerClient } from './client.js';
import { WorkerRuntime } from './client.js';

const sessions: readonly TaskEnvelope[] = [
  {
    id: 'session_a',
    kind: 'browse',
    goal: 'interactive',
    interaction: 'interactive',
    profileId: 'profile_a'
  },
  {
    id: 'session_b',
    kind: 'browse',
    goal: 'interactive',
    interaction: 'interactive',
    profileId: 'profile_b'
  },
  {
    id: 'session_ephemeral',
    kind: 'browse',
    goal: 'interactive',
    interaction: 'interactive'
  }
];

describe('interactive profile isolation', () => {
  it('isolates named profiles and removes anonymous session state on one worker', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'talos-interactive-profiles-'));
    const selectedPaths: string[] = [];
    const polls = new Map<string, number>();
    let claimIndex = 0;
    const browserExecutors = new BrowserExecutorFactory({
      profileRoot,
      createBrowserExecutor: (options) => {
        selectedPaths.push(options.profilePath);
        return {
          execute: async () => ({ value: 'done' }),
          close: async () => undefined
        };
      }
    });
    const client: WorkerClient = {
      claim: async () => {
        const task = sessions[claimIndex];
        claimIndex += 1;
        if (task === undefined) throw new Error('no session queued');
        return { task, leaseToken: `lease_${task.id}` };
      },
      heartbeat: async () => ({ status: 'running' }),
      result: async () => undefined,
      artifact: async () => undefined,
      needsInput: async () => undefined,
      getInput: async () => undefined,
      pollAction: async (taskId) => {
        const count = polls.get(taskId) ?? 0;
        polls.set(taskId, count + 1);
        return count === 0
          ? {
              closing: false,
              action: { id: `action_${taskId}`, action: { type: 'wait', milliseconds: 1 } }
            }
          : { closing: true };
      },
      actionResult: async () => undefined
    };
    const runtime = new WorkerRuntime({
      client,
      createExecutor: (task) => browserExecutors.create(task),
      planner: {
        plan: async () => {
          throw new Error('interactive sessions must not invoke the planner');
        }
      }
    });

    await runtime.runOnce();
    await runtime.runOnce();
    await runtime.runOnce();

    expect(selectedPaths[0]).toBe(join(profileRoot, 'profiles', 'profile_a'));
    expect(selectedPaths[1]).toBe(join(profileRoot, 'profiles', 'profile_b'));
    expect(selectedPaths[0]).not.toBe(selectedPaths[1]);
    expect(existsSync(selectedPaths[0] ?? '')).toBe(true);
    expect(existsSync(selectedPaths[1] ?? '')).toBe(true);
    expect(selectedPaths[2]?.startsWith(join(profileRoot, 'ephemeral', 'task-'))).toBe(true);
    expect(existsSync(selectedPaths[2] ?? '')).toBe(false);
  });
});
