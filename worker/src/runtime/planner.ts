import type { TaskEnvelope, ActionPlanner, PlannerDecision } from './client.js';

export class ScriptedPlanner implements ActionPlanner {
  private readonly actions: readonly PlannerDecision[];
  private index = 0;

  public constructor(actions: readonly PlannerDecision[] = [{ type: 'done', findings: [] }]) {
    this.actions = actions;
  }

  public async plan(_task: TaskEnvelope, _lastResult: unknown): Promise<PlannerDecision> {
    const decision = this.actions[Math.min(this.index++, this.actions.length - 1)];
    return decision ?? { type: 'done', findings: [] };
  }
}
