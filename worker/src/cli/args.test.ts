import { describe, expect, it } from 'vitest';
import { cliHelp, parseCliArguments } from './args.js';

describe('worker CLI arguments', () => {
  it('parses non-interactive init options and help', () => {
    expect(parseCliArguments(['init', '--control-plane-url', 'http://talos', '--machine-id', 'machine', '--worker-id', 'worker', '--token-env', 'TOKEN', '--profile-path', '/profile'])).toEqual({
      command: 'init',
      controlPlaneUrl: 'http://talos',
      machineId: 'machine',
      workerId: 'worker',
      tokenEnv: 'TOKEN',
      profilePath: '/profile'
    });
    expect(parseCliArguments(['init', '--help'])).toEqual({ command: 'help' });
    expect(cliHelp).toContain('--token-env');
  });

  it('rejects unknown commands, flags, missing values, and malformed service actions', () => {
    expect(() => parseCliArguments(['unknown'])).toThrow('unknown command');
    expect(() => parseCliArguments(['init', '--bad', 'value'])).toThrow('unknown init option');
    expect(() => parseCliArguments(['init', '--machine-id'])).toThrow('requires a value');
    expect(() => parseCliArguments(['run', 'extra'])).toThrow('does not accept arguments');
    expect(() => parseCliArguments(['service', 'start'])).toThrow('service <install|uninstall>');
  });
});
