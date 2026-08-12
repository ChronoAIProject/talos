import type { Action, ActionResult } from '../protocol/actions.js';

export interface ExecutorContext {
  readonly taskId: string;
  readonly masking: boolean;
}

export interface Executor {
  execute(action: Action, context: ExecutorContext): Promise<ActionResult>;
  close(): Promise<void>;
}
