import { BrowserExecutorFactory } from './executor/browser-executor-factory.js';
import type { Executor } from './executor/executor.js';
import { HttpWorkerClient } from './runtime/http-client.js';
import { WorkerRuntime, type TaskEnvelope } from './runtime/client.js';
import { ScriptedPlanner } from './runtime/planner.js';
import { createWorkerLogger } from './runtime/logger.js';
import { loadWorkerConfig } from './config.js';

export { loadWorkerConfig } from './config.js';

export interface DaemonDependencies {
  createClient?: (config: ReturnType<typeof loadWorkerConfig>) => HttpWorkerClient;
  createExecutor?: (
    task: TaskEnvelope,
    config: ReturnType<typeof loadWorkerConfig>
  ) => Executor | Promise<Executor>;
  createRuntime?: (
    client: HttpWorkerClient,
    createExecutor: (task: TaskEnvelope) => Executor | Promise<Executor>,
    config: ReturnType<typeof loadWorkerConfig>
  ) => WorkerRuntime;
  sleep?: (milliseconds: number) => Promise<void>;
}

export const runWorkerDaemon = async (
  env: NodeJS.ProcessEnv = process.env,
  dependencies: DaemonDependencies = {}
): Promise<() => Promise<void>> => {
  const config = loadWorkerConfig(env);
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const client = dependencies.createClient?.(config) ?? new HttpWorkerClient(config);
  const browserExecutors = new BrowserExecutorFactory({
    profileRoot: config.profilePath,
    ...(config.cdpEndpoint === undefined ? {} : { cdpEndpoint: config.cdpEndpoint })
  });
  const createExecutor = (task: TaskEnvelope): Executor | Promise<Executor> =>
    dependencies.createExecutor?.(task, config) ?? browserExecutors.create(task);
  const runtime = dependencies.createRuntime?.(client, createExecutor, config) ?? new WorkerRuntime({
    client,
    createExecutor,
    planner: new ScriptedPlanner([
      { type: 'action', action: { type: 'screenshot' } },
      { type: 'done', findings: [] }
    ]),
    heartbeatMs: config.heartbeatMs,
    inputPollMs: config.inputPollMs,
    actionPollMs: config.actionPollMs,
    sessionIdleMs: config.sessionIdleMs,
    logger: createWorkerLogger()
  });
  let stopped = false;
  const signalStop = (): void => {
    stopped = true;
  };
  const loop = async (): Promise<void> => {
    let backoff = config.pollMs;
    while (!stopped) {
      try {
        await runtime.runOnce();
        backoff = config.pollMs;
        await sleep(config.pollMs);
      } catch {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  };
  process.once('SIGINT', signalStop);
  process.once('SIGTERM', signalStop);
  const running = loop();
  return async (): Promise<void> => {
    stopped = true;
    await running;
    process.off('SIGINT', signalStop);
    process.off('SIGTERM', signalStop);
  };
};
