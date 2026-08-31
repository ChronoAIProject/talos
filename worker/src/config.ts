import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { workerConfigFileSchema, workerConfigSchema, type WorkerConfig } from './runtime/client.js';

export const defaultWorkerDirectory = (home = homedir()): string => join(home, '.talos-worker');
export const defaultWorkerConfigPath = (home = homedir()): string => join(defaultWorkerDirectory(home), 'config.json');
export const defaultProfilePath = (home = homedir()): string => join(defaultWorkerDirectory(home), 'profile');

export const readWorkerConfigFile = (path = defaultWorkerConfigPath()): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`unable to read worker config at ${path}: ${errorMessage(error)}`);
  }
};

export const writeWorkerConfigFile = (config: WorkerConfig, path = defaultWorkerConfigPath()): void => {
  const validated = workerConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

export const loadWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env,
  fileConfig?: unknown
): WorkerConfig => {
  const stored = fileConfig === undefined ? {} : workerConfigFileSchema.parse(fileConfig);
  return workerConfigSchema.parse({
    ...stored,
    ...(env.TALOS_CONTROL_PLANE_URL === undefined ? {} : { controlPlaneUrl: env.TALOS_CONTROL_PLANE_URL }),
    ...(env.TALOS_WORKER_ID === undefined ? {} : { workerId: env.TALOS_WORKER_ID }),
    ...(env.TALOS_MACHINE_ID === undefined ? {} : { machineId: env.TALOS_MACHINE_ID }),
    ...(env.TALOS_WORKER_TOKEN === undefined ? {} : { workerToken: env.TALOS_WORKER_TOKEN }),
    ...(env.TALOS_PROFILE_PATH === undefined ? {} : { profilePath: env.TALOS_PROFILE_PATH }),
    ...(env.TALOS_CDP_ENDPOINT === undefined ? {} : { cdpEndpoint: env.TALOS_CDP_ENDPOINT }),
    ...(env.TALOS_HEARTBEAT_MS === undefined ? {} : { heartbeatMs: env.TALOS_HEARTBEAT_MS }),
    ...(env.TALOS_POLL_MS === undefined ? {} : { pollMs: env.TALOS_POLL_MS }),
    ...(env.TALOS_INPUT_POLL_MS === undefined ? {} : { inputPollMs: env.TALOS_INPUT_POLL_MS }),
    ...(env.TALOS_ACTION_POLL_MS === undefined ? {} : { actionPollMs: env.TALOS_ACTION_POLL_MS }),
    ...(env.TALOS_SESSION_IDLE_MS === undefined ? {} : { sessionIdleMs: env.TALOS_SESSION_IDLE_MS }),
    ...(env.TALOS_TESTING_RUNTIME_URL === undefined ? {} : { testingRuntimeUrl: env.TALOS_TESTING_RUNTIME_URL }),
    ...(env.TALOS_TESTING_RUNTIME_CREDENTIAL === undefined ? {} : { testingRuntimeCredential: env.TALOS_TESTING_RUNTIME_CREDENTIAL }),
    ...(env.TALOS_TESTING_AUTHORIZATION_RESOLVER_URL === undefined ? {} : { testingAuthorizationResolverUrl: env.TALOS_TESTING_AUTHORIZATION_RESOLVER_URL }),
    ...(env.TALOS_TESTING_AUTHORIZATION_RESOLVER_TOKEN === undefined ? {} : { testingAuthorizationResolverToken: env.TALOS_TESTING_AUTHORIZATION_RESOLVER_TOKEN })
  });
};

export const workerConfigToEnv = (config: WorkerConfig): NodeJS.ProcessEnv => ({
  TALOS_CONTROL_PLANE_URL: config.controlPlaneUrl,
  TALOS_WORKER_ID: config.workerId,
  TALOS_MACHINE_ID: config.machineId,
  TALOS_WORKER_TOKEN: config.workerToken,
  TALOS_PROFILE_PATH: config.profilePath,
  TALOS_HEARTBEAT_MS: String(config.heartbeatMs),
  TALOS_POLL_MS: String(config.pollMs),
  TALOS_INPUT_POLL_MS: String(config.inputPollMs),
  TALOS_ACTION_POLL_MS: String(config.actionPollMs),
  TALOS_SESSION_IDLE_MS: String(config.sessionIdleMs),
  ...(config.cdpEndpoint === undefined ? {} : { TALOS_CDP_ENDPOINT: config.cdpEndpoint }),
  ...(config.testingRuntimeUrl === undefined ? {} : { TALOS_TESTING_RUNTIME_URL: config.testingRuntimeUrl }),
  ...(config.testingRuntimeCredential === undefined ? {} : { TALOS_TESTING_RUNTIME_CREDENTIAL: config.testingRuntimeCredential }),
  ...(config.testingAuthorizationResolverUrl === undefined ? {} : { TALOS_TESTING_AUTHORIZATION_RESOLVER_URL: config.testingAuthorizationResolverUrl }),
  ...(config.testingAuthorizationResolverToken === undefined ? {} : { TALOS_TESTING_AUTHORIZATION_RESOLVER_TOKEN: config.testingAuthorizationResolverToken })
});

const errorMessage = (error: unknown): string => error instanceof Error
  ? error.message
  : 'unknown error';
