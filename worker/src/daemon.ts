import { pathToFileURL } from 'node:url';
import { BrowserExecutor } from './executor/browser-executor.js';
import { workerConfigSchema } from './runtime/client.js';
import { HttpWorkerClient } from './runtime/http-client.js';
import { WorkerRuntime } from './runtime/client.js';
import { ScriptedPlanner } from './runtime/planner.js';

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env) => workerConfigSchema.parse({
  controlPlaneUrl: env.TALOS_CONTROL_PLANE_URL,
  workerId: env.TALOS_WORKER_ID,
  machineId: env.TALOS_MACHINE_ID,
  workerToken: env.TALOS_WORKER_TOKEN,
  profilePath: env.TALOS_PROFILE_PATH ?? './talos-profile',
  cdpEndpoint: env.TALOS_CDP_ENDPOINT,
  heartbeatMs: env.TALOS_HEARTBEAT_MS,
  pollMs: env.TALOS_POLL_MS
});

export const runWorkerDaemon = async (env: NodeJS.ProcessEnv = process.env): Promise<() => void> => {
  const config = loadWorkerConfig(env);
  const client = new HttpWorkerClient(config);
  const executor = new BrowserExecutor({ profilePath: config.profilePath, ...(config.cdpEndpoint === undefined ? {} : { cdpEndpoint: config.cdpEndpoint }) });
  const runtime = new WorkerRuntime({ client, executor, planner: new ScriptedPlanner([{ type: 'action', action: { type: 'screenshot' } }, { type: 'done', findings: [] }]), heartbeatMs: config.heartbeatMs, logger: { warn: (message, fields) => process.stderr.write(JSON.stringify({ level: 'warn', message, ...fields }) + '\n'), error: (message, fields) => process.stderr.write(JSON.stringify({ level: 'error', message, ...fields }) + '\n') } });
  let stopped = false;
  const stop = (): void => { stopped = true; };
  const loop = async (): Promise<void> => {
    let backoff = config.pollMs;
    while (!stopped) {
      try {
        await runtime.runOnce();
        backoff = config.pollMs;
      } catch (error) {
        if (error instanceof Error && error.message.includes('not_found')) {
          await new Promise((resolve) => setTimeout(resolve, backoff));
          backoff = Math.min(backoff * 2, 30000);
        } else {
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }
    await executor.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  void loop();
  return stop;
};

/* c8 ignore next: process entrypoint branch is exercised by the deployed daemon, not unit imports. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWorkerDaemon();
}
