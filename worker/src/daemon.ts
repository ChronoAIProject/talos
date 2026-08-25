import { BrowserExecutorFactory } from './executor/browser-executor-factory.js';
import type { Executor } from './executor/executor.js';
import { HttpWorkerClient } from './runtime/http-client.js';
import { WorkerRuntime, type TaskEnvelope } from './runtime/client.js';
import { ScriptedPlanner } from './runtime/planner.js';
import { createWorkerLogger } from './runtime/logger.js';
import { loadWorkerConfig } from './config.js';
import { HttpTestingAuthorizationResolver } from './testing/authorization-resolver.js';
import { HttpTestingWorkerClient, type TestingWorkerControlPlane } from './testing/control-plane-client.js';
import { HttpLocalQARuntimeAdapter, type LocalQARuntimeAdapter } from './testing/runtime-adapter.js';
import { safeTestingErrorMessage } from './testing/safe-log-error.js';
import { TestingWorkerRuntime, type TestingAuthorizationResolver } from './testing/testing-executor.js';

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
  createTestingControlPlane?: (
    config: ReturnType<typeof loadWorkerConfig>
  ) => TestingWorkerControlPlane;
  createLocalQARuntimeAdapter?: (
    config: ReturnType<typeof loadWorkerConfig>
  ) => LocalQARuntimeAdapter;
  createTestingAuthorizationResolver?: (
    config: ReturnType<typeof loadWorkerConfig>
  ) => TestingAuthorizationResolver;
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
  const logger = createWorkerLogger();
  const testingRuntime = config.testingRuntimeUrl === undefined
    ? undefined
    : new TestingWorkerRuntime({
        controlPlane: dependencies.createTestingControlPlane?.(config) ?? new HttpTestingWorkerClient(config),
        runtime: dependencies.createLocalQARuntimeAdapter?.(config) ?? new HttpLocalQARuntimeAdapter({
          baseUrl: config.testingRuntimeUrl,
          credential: config.testingRuntimeCredential
        }),
        authorizations: dependencies.createTestingAuthorizationResolver?.(config) ?? new HttpTestingAuthorizationResolver({
          url: config.testingAuthorizationResolverUrl,
          token: config.testingAuthorizationResolverToken
        }),
        heartbeatMs: config.heartbeatMs,
        pollMs: config.pollMs,
        logger
      });
  let stopped = false;
  const signalStop = (): void => {
    stopped = true;
    testingRuntime?.stop();
  };
  const loop = async (): Promise<void> => {
    let backoff = config.pollMs;
    while (!stopped) {
      try {
        let handledTesting = false;
        if (testingRuntime !== undefined) {
          try {
            handledTesting = await testingRuntime.runOnce();
          } catch (error) {
            if (!stopped) {
              logger.warn('testing outbound poll failed', {
                error: safeTestingErrorMessage(error)
              });
            }
          }
        }
        if (stopped) break;
        if (!handledTesting) await runtime.runOnce();
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
    testingRuntime?.stop();
    await running;
    process.off('SIGINT', signalStop);
    process.off('SIGTERM', signalStop);
  };
};
