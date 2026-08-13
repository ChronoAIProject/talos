export interface InitArguments {
  command: 'init';
  controlPlaneUrl?: string;
  machineId?: string;
  workerId?: string;
  tokenEnv: string;
  profilePath?: string;
}

export type CliArguments =
  | { command: 'help' }
  | InitArguments
  | { command: 'run' }
  | { command: 'status' }
  | { command: 'service'; action: 'install' | 'uninstall' };

const initFlags = new Map([
  ['--control-plane-url', 'controlPlaneUrl'],
  ['--machine-id', 'machineId'],
  ['--worker-id', 'workerId'],
  ['--token-env', 'tokenEnv'],
  ['--profile-path', 'profilePath']
] as const);

export const parseCliArguments = (arguments_: readonly string[]): CliArguments => {
  const [command, ...rest] = arguments_;
  if (command === undefined || command === '--help' || command === '-h' || rest.includes('--help') || rest.includes('-h')) return { command: 'help' };
  if (command === 'run' || command === 'status') {
    if (rest.length !== 0) throw new Error(`${command} does not accept arguments`);
    return { command };
  }
  if (command === 'service') {
    const [action, ...extra] = rest;
    if ((action !== 'install' && action !== 'uninstall') || extra.length !== 0) throw new Error('usage: talos-worker service <install|uninstall>');
    return { command, action };
  }
  if (command !== 'init') throw new Error(`unknown command: ${command}`);
  const values: Omit<InitArguments, 'command'> = { tokenEnv: 'TALOS_WORKER_TOKEN' };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    const field = flag === undefined ? undefined : initFlags.get(flag as '--control-plane-url' | '--machine-id' | '--worker-id' | '--token-env' | '--profile-path');
    if (field === undefined) throw new Error(`unknown init option: ${flag ?? ''}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values[field] = value;
  }
  return { command, ...values };
};

export const cliHelp = `Usage: talos-worker <command>

Commands:
  init       Configure this machine and install Chromium
  run        Start the worker daemon
  status     Show configuration, control-plane, and service status
  service install
  service uninstall

Init options:
  --control-plane-url <url>
  --machine-id <id>
  --worker-id <id>
  --token-env <name>       Read the worker token from this environment variable
  --profile-path <path>
`;
