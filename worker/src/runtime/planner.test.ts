import { describe, expect, it } from 'vitest';
import { ScriptedPlanner } from './planner.js';

describe('ScriptedPlanner', () => {
  it('returns scripted decisions and repeats the final decision', async () => {
    const planner = new ScriptedPlanner([{ type: 'action', action: { type: 'wait', milliseconds: 0 } }, { type: 'done', findings: [] }]);
    const task = { id: 't', kind: 'browse' as const, goal: 'x', interaction: 'autonomous' as const };
    expect((await planner.plan(task, undefined)).type).toBe('action');
    expect((await planner.plan(task, undefined)).type).toBe('done');
    expect((await planner.plan(task, undefined)).type).toBe('done');
  });
});
