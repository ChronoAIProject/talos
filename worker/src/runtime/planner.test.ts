import { describe, expect, it } from 'vitest';
import { ScriptedPlanner } from './planner.js';

describe('ScriptedPlanner', () => {
  it('returns scripted decisions and repeats the final decision', async () => {
    const planner = new ScriptedPlanner([{ type: 'action', action: { type: 'wait', milliseconds: 0 } }, { type: 'done', findings: [] }]);
    expect((await planner.plan({ id: 't', kind: 'browse', goal: 'x' }, undefined)).type).toBe('action');
    expect((await planner.plan({ id: 't', kind: 'browse', goal: 'x' }, undefined)).type).toBe('done');
    expect((await planner.plan({ id: 't', kind: 'browse', goal: 'x' }, undefined)).type).toBe('done');
  });
});
