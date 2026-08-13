import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export type SupportedServicePlatform = 'darwin' | 'linux';

export interface ServiceDefinition {
  path: string;
  content: string;
}

export interface ServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  executablePath?: string;
  run?: (command: string, arguments_: readonly string[]) => Promise<void>;
}

const execFileAsync = promisify(execFile);
const label = 'ai.chrono.talos-worker';

export const serviceDefinition = (
  platform: SupportedServicePlatform,
  home = homedir(),
  executablePath = join(home, '.local', 'bin', 'talos-worker')
): ServiceDefinition => platform === 'darwin'
  ? {
      path: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
      content: launchdPlist(executablePath, home)
    }
  : {
      path: join(home, '.config', 'systemd', 'user', 'talos-worker.service'),
      content: systemdUnit(executablePath, home)
    };

export const installService = async (options: ServiceOptions = {}): Promise<ServiceDefinition> => {
  const platform = supportedPlatform(options.platform ?? process.platform);
  const definition = serviceDefinition(platform, options.home, options.executablePath);
  mkdirSync(dirname(definition.path), { recursive: true });
  writeFileSync(definition.path, definition.content, { mode: 0o644 });
  await serviceRunner(options)(
    platform === 'darwin' ? 'launchctl' : 'systemctl',
    platform === 'darwin'
      ? ['bootstrap', `gui/${process.getuid?.() ?? 0}`, definition.path]
      : ['--user', 'enable', '--now', 'talos-worker.service']
  );
  return definition;
};

export const uninstallService = async (options: ServiceOptions = {}): Promise<ServiceDefinition> => {
  const platform = supportedPlatform(options.platform ?? process.platform);
  const definition = serviceDefinition(platform, options.home, options.executablePath);
  await serviceRunner(options)(
    platform === 'darwin' ? 'launchctl' : 'systemctl',
    platform === 'darwin'
      ? ['bootout', `gui/${process.getuid?.() ?? 0}`, definition.path]
      : ['--user', 'disable', '--now', 'talos-worker.service']
  );
  rmSync(definition.path, { force: true });
  return definition;
};

export const serviceLoaded = async (options: ServiceOptions = {}): Promise<boolean> => {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return false;
  try {
    await serviceRunner(options)(
      platform === 'darwin' ? 'launchctl' : 'systemctl',
      platform === 'darwin'
        ? ['print', `gui/${process.getuid?.() ?? 0}/${label}`]
        : ['--user', 'is-active', '--quiet', 'talos-worker.service']
    );
    return true;
  } catch {
    return false;
  }
};

export const windowsServiceInstructions = 'Windows background service installation is not automated. Run `talos-worker run` from Task Scheduler or a supervised terminal; see docs/WORKER.md.';

const supportedPlatform = (platform: NodeJS.Platform): SupportedServicePlatform => {
  if (platform === 'darwin' || platform === 'linux') return platform;
  throw new Error(windowsServiceInstructions);
};

const serviceRunner = (options: ServiceOptions) => options.run ?? (async (command: string, arguments_: readonly string[]) => {
  await execFileAsync(command, [...arguments_]);
});

const launchdPlist = (executablePath: string, home: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(executablePath)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(join(home, '.talos-worker', 'worker.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(home, '.talos-worker', 'worker-error.log'))}</string>
</dict>
</plist>
`;

const systemdUnit = (executablePath: string, home: string): string => `[Unit]
Description=Talos worker daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdEscape(executablePath)} run
Restart=on-failure
RestartSec=5
Environment=HOME=${systemdEscape(home)}

[Install]
WantedBy=default.target
`;

const escapeXml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const systemdEscape = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
