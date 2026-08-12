import { pathToFileURL } from 'node:url';
import { BrowserExecutor } from './executor/browser-executor.js';
import { workerConfigSchema } from './runtime/client.js';
import { HttpWorkerClient } from './runtime/http-client.js';
import { WorkerRuntime } from './runtime/client.js';
import { ScriptedPlanner } from './runtime/planner.js';
import { createWorkerLogger } from './runtime/logger.js';
import { WorkerClientError } from './runtime/errors.js';

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env) =>
  workerConfigSchema.parse({
    controlPlaneUrl: env.TALOS_CONTROL_PLANE_URL,
    workerId: env.TALOS_WORKER_ID,
    machineId: env.TALOS_MACHINE_ID,
    workerToken: env.TALOS_WORKER_TOKEN,
    profilePath: env.TALOS_PROFILE_PATH ?? './talos-profile',
    cdpEndpoint: env.TALOS_CDP_ENDPOINT,
    heartbeatMs: env.TALOS_HEARTBEAT_MS,
    pollMs: env.TALOS_POLL_MS,
    inputPollMs: env.TALOS_INPUT_POLL_MS
  });

export interface DaemonDependencies {
  createClient?: (config: ReturnType<typeof loadWorkerConfig>) => HttpWorkerClient;
  createExecutor?: (config: ReturnType<typeof loadWorkerConfig>) => BrowserExecutor;
  createRuntime?: (client: HttpWorkerClient, executor: BrowserExecutor, config: ReturnType<typeof loadWorkerConfig>) => WorkerRuntime;
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
  const executor = dependencies.createExecutor?.(config) ?? new BrowserExecutor({
    profilePath: config.profilePath,
    ...(config.cdpEndpoint === undefined ? {} : { cdpEndpoint: config.cdpEndpoint })
  });
  const runtime = dependencies.createRuntime?.(client, executor, config) ?? new WorkerRuntime({
    client,
    executor,
    planner: new ScriptedPlanner([
      { type: 'action', action: { type: 'screenshot' } },
      { type: 'done', findings: [] }
    ]),
    heartbeatMs: config.heartbeatMs,
    inputPollMs: config.inputPollMs,
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
      } catch (error) {
        if (error instanceof WorkerClientError && error.code === 'not_found') {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30000);
        } else {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30000);
        }
      }
    }
    await executor.close();
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

/* c8 ignore next: process entrypoint branch is exercised by the deployed daemon, not unit imports. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWorkerDaemon();
}
