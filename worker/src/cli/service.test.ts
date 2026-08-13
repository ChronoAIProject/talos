import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installService, serviceDefinition, serviceLoaded, uninstallService } from './service.js';

describe('worker background services', () => {
  it('generates launchd and systemd definitions that run the CLI without credentials', () => {
    const launchd = serviceDefinition('darwin', '/Users/alice', '/Users/alice/.local/bin/talos-worker');
    expect(launchd.path).toContain('Library/LaunchAgents/ai.chrono.talos-worker.plist');
    expect(launchd.content).toContain('<string>/Users/alice/.local/bin/talos-worker</string><string>run</string>');
    expect(launchd.content).not.toContain('TOKEN');
    const systemd = serviceDefinition('linux', '/home/alice', '/home/alice/.local/bin/talos-worker');
    expect(systemd.path).toContain('.config/systemd/user/talos-worker.service');
    expect(systemd.content).toContain('ExecStart="/home/alice/.local/bin/talos-worker" run');
    expect(systemd.content).not.toContain('TOKEN');
  });

  it('writes, loads, and removes a systemd user service', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talos-service-'));
    const invocations: string[][] = [];
    const run = async (command: string, arguments_: readonly string[]) => { invocations.push([command, ...arguments_]); };
    const installed = await installService({ platform: 'linux', home, run });
    expect(readFileSync(installed.path, 'utf8')).toContain('talos-worker" run');
    expect(invocations[0]).toEqual(['systemctl', '--user', 'enable', '--now', 'talos-worker.service']);
    expect(await serviceLoaded({ platform: 'linux', home, run })).toBe(true);
    await uninstallService({ platform: 'linux', home, run });
    expect(invocations.at(-1)).toEqual(['systemctl', '--user', 'disable', '--now', 'talos-worker.service']);
  });

  it('reports unsupported and unloaded service states', async () => {
    expect(() => serviceDefinition('linux', '/home/a', '/path with space/talos-worker')).not.toThrow();
    expect(await serviceLoaded({ platform: 'win32' })).toBe(false);
    expect(await serviceLoaded({ platform: 'darwin', run: async () => { throw new Error('not loaded'); } })).toBe(false);
    await expect(installService({ platform: 'win32' })).rejects.toThrow('not automated');
  });
});
