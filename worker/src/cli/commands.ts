import { existsSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { workerConfigSchema, type WorkerConfig } from '../runtime/client.js';
import { runWorkerDaemon } from '../daemon.js';
import {
  defaultProfilePath,
  defaultWorkerConfigPath,
  loadWorkerConfig,
  readWorkerConfigFile,
  workerConfigToEnv,
  writeWorkerConfigFile
} from '../config.js';
import type { InitArguments } from './args.js';
import { checkControlPlaneHealth } from './health.js';
import { installChromium } from './chromium.js';
import type { Printer } from './printer.js';
import type { Prompter } from './prompts.js';
import { installService, serviceLoaded, uninstallService, windowsServiceInstructions } from './service.js';

export interface CommandDependencies {
  env?: NodeJS.ProcessEnv;
  home?: string;
  host?: string;
  platform?: NodeJS.Platform;
  executablePath?: string;
  configPath?: string;
  printer: Printer;
  prompter: Prompter;
  fetcher?: typeof fetch;
  writeConfig?: (config: WorkerConfig, path: string) => void;
  readConfig?: (path: string) => unknown;
  configExists?: (path: string) => boolean;
  installBrowser?: () => Promise<void>;
  startDaemon?: typeof runWorkerDaemon;
  serviceRun?: (command: string, arguments_: readonly string[]) => Promise<void>;
}

export const initCommand = async (arguments_: InitArguments, dependencies: CommandDependencies): Promise<void> => {
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const host = dependencies.host ?? hostname();
  const controlPlaneUrl = arguments_.controlPlaneUrl ?? await dependencies.prompter.text('Control plane URL');
  const machineId = arguments_.machineId ?? await dependencies.prompter.text('Machine ID', host);
  const workerId = arguments_.workerId ?? await dependencies.prompter.text('Worker ID', `${host}-worker`);
  const workerToken = env[arguments_.tokenEnv] ?? await dependencies.prompter.secret('Worker token');
  const profilePath = arguments_.profilePath ?? await dependencies.prompter.text('Profile path', defaultProfilePath(home));
  const config = workerConfigSchema.parse({ controlPlaneUrl, machineId, workerId, workerToken, profilePath });
  const configPath = dependencies.configPath ?? defaultWorkerConfigPath(home);
  (dependencies.writeConfig ?? writeWorkerConfigFile)(config, configPath);
  dependencies.printer.out(`Configuration written to ${configPath}`);
  await checkControlPlaneHealth(config.controlPlaneUrl, dependencies.fetcher);
  dependencies.printer.out('Installing Playwright Chromium...');
  await (dependencies.installBrowser ?? installChromium)();
  dependencies.printer.out('Worker initialized. Run `talos-worker run` or `talos-worker service install`.');
};

export const runCommand = async (dependencies: CommandDependencies): Promise<void> => {
  const home = dependencies.home ?? homedir();
  const configPath = dependencies.configPath ?? defaultWorkerConfigPath(home);
  const exists = (dependencies.configExists ?? existsSync)(configPath);
  const stored = exists ? (dependencies.readConfig ?? readWorkerConfigFile)(configPath) : {};
  const config = loadWorkerConfig(dependencies.env ?? process.env, stored);
  await (dependencies.startDaemon ?? runWorkerDaemon)(workerConfigToEnv(config));
};

export const statusCommand = async (dependencies: CommandDependencies): Promise<void> => {
  const home = dependencies.home ?? homedir();
  const configPath = dependencies.configPath ?? defaultWorkerConfigPath(home);
  const exists = (dependencies.configExists ?? existsSync)(configPath);
  dependencies.printer.out(`Config: ${exists ? `present (${configPath})` : 'missing'}`);
  if (exists) {
    const config = loadWorkerConfig(dependencies.env ?? process.env, (dependencies.readConfig ?? readWorkerConfigFile)(configPath));
    try {
      await checkControlPlaneHealth(config.controlPlaneUrl, dependencies.fetcher);
      dependencies.printer.out(`Control plane: healthy (${config.controlPlaneUrl})`);
    } catch (error) {
      dependencies.printer.out(`Control plane: unreachable (${errorMessage(error)})`);
    }
  }
  const loaded = await serviceLoaded(serviceOptions(dependencies, home));
  dependencies.printer.out(`Service: ${loaded ? 'loaded' : 'not loaded'}`);
};

export const serviceCommand = async (
  action: 'install' | 'uninstall',
  dependencies: CommandDependencies
): Promise<void> => {
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    dependencies.printer.out(windowsServiceInstructions);
    return;
  }
  const home = dependencies.home ?? homedir();
  const options = serviceOptions(dependencies, home);
  const definition = action === 'install'
    ? await installService(options)
    : await uninstallService(options);
  dependencies.printer.out(`Service ${action === 'install' ? 'installed' : 'uninstalled'}: ${definition.path}`);
};

const serviceOptions = (dependencies: CommandDependencies, home: string) => ({
  platform: dependencies.platform,
  home,
  executablePath: dependencies.executablePath ?? join(home, '.local', 'bin', 'talos-worker'),
  run: dependencies.serviceRun
});

const errorMessage = (error: unknown): string => error instanceof Error
  ? error.message
  : 'unknown error';
