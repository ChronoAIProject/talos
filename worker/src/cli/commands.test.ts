import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initCommand, runCommand, serviceCommand, statusCommand, type CommandDependencies } from './commands.js';
import type { Printer } from './printer.js';

const outputPrinter = (): { printer: Printer; output: string[]; errors: string[] } => {
  const output: string[] = [];
  const errors: string[] = [];
  return { printer: { out: (message) => output.push(message), error: (message) => errors.push(message) }, output, errors };
};

const baseDependencies = (printer: Printer): CommandDependencies => ({
  printer,
  prompter: {
    text: async () => { throw new Error('unexpected prompt'); },
    secret: async () => { throw new Error('unexpected secret prompt'); }
  }
});

describe('worker CLI commands', () => {
  it('initializes non-interactively, checks health, and writes a 0600 config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talos-init-'));
    const { printer, output } = outputPrinter();
    let browserInstalled = false;
    await initCommand({
      command: 'init',
      controlPlaneUrl: 'http://talos.internal',
      machineId: 'machine-a',
      workerId: 'worker-a',
      tokenEnv: 'MACHINE_TOKEN',
      profilePath: join(home, 'profile')
    }, {
      ...baseDependencies(printer),
      home,
      env: { MACHINE_TOKEN: 'worker-token-123456' },
      fetcher: async (input) => {
        expect(input.toString()).toBe('http://talos.internal/healthz');
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      },
      installBrowser: async () => { browserInstalled = true; }
    });
    const path = join(home, '.talos-worker', 'config.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ machineId: 'machine-a', workerToken: 'worker-token-123456' });
    expect(output.join('\n')).not.toContain('worker-token-123456');
    expect(browserInstalled).toBe(true);
  });

  it('loads file config with environment overrides before starting the daemon', async () => {
    const { printer } = outputPrinter();
    let daemonEnvironment: NodeJS.ProcessEnv | undefined;
    await runCommand({
      ...baseDependencies(printer),
      env: { TALOS_MACHINE_ID: 'env-machine' },
      configExists: () => true,
      readConfig: () => ({ controlPlaneUrl: 'http://talos', machineId: 'file-machine', workerId: 'worker', workerToken: 'worker-token-123456', profilePath: '/profile' }),
      startDaemon: async (env) => {
        daemonEnvironment = env;
        return async () => undefined;
      }
    });
    expect(daemonEnvironment?.TALOS_MACHINE_ID).toBe('env-machine');
    expect(daemonEnvironment?.TALOS_WORKER_TOKEN).toBe('worker-token-123456');
  });

  it('starts from environment-only configuration when no file exists', async () => {
    const { printer } = outputPrinter();
    let started = false;
    await runCommand({
      ...baseDependencies(printer),
      env: {
        TALOS_CONTROL_PLANE_URL: 'http://talos',
        TALOS_MACHINE_ID: 'machine',
        TALOS_WORKER_ID: 'worker',
        TALOS_WORKER_TOKEN: 'worker-token-123456'
      },
      configExists: () => false,
      startDaemon: async () => {
        started = true;
        return async () => undefined;
      }
    });
    expect(started).toBe(true);
  });

  it('shows status without printing the token and prints Windows service guidance', async () => {
    const { printer, output } = outputPrinter();
    const dependencies = {
      ...baseDependencies(printer),
      platform: 'win32' as const,
      configExists: () => true,
      readConfig: () => ({ controlPlaneUrl: 'http://talos', machineId: 'machine', workerId: 'worker', workerToken: 'secret-token-123456', profilePath: '/profile' }),
      fetcher: async () => new Response('{}', { status: 503 })
    };
    await statusCommand(dependencies);
    await serviceCommand('install', dependencies);
    expect(output.join('\n')).toContain('Control plane: unreachable');
    expect(output.join('\n')).toContain('Check the NyxID public worker URL');
    expect(output.join('\n')).toContain('Windows background service installation is not automated');
    expect(output.join('\n')).not.toContain('secret-token-123456');
  });
});
