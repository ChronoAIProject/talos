import { describe, expect, it } from 'vitest';
import { runCli } from './main.js';
import { nonInteractivePromptMessage } from './prompts.js';

describe('worker CLI main', () => {
  it('prints help and maps parsing failures to exit codes', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const printer = { out: (message: string) => output.push(message), error: (message: string) => errors.push(message) };
    const prompter = { text: async () => '', secret: async () => '' };
    await expect(runCli(['--help'], { printer, prompter })).resolves.toBe(0);
    expect(output.join('\n')).toContain('Usage: talos-worker');
    await expect(runCli(['bad'], { printer, prompter })).resolves.toBe(1);
    expect(errors).toEqual(['unknown command: bad']);
  });

  it('reports a missing non-interactive init flag and does not write config', async () => {
    const errors: string[] = [];
    let configWritten = false;
    const result = await runCli([
      'init',
      '--control-plane-url', 'https://nyxid.example.com/public/s/talos-worker',
      '--machine-id', 'machine',
      '--worker-id', 'worker',
      '--token-env', 'WORKER_TOKEN'
    ], {
      env: { WORKER_TOKEN: 'worker-token-123456' },
      printer: { out: () => undefined, error: (message) => errors.push(message) },
      prompter: {
        text: async () => { throw new Error(nonInteractivePromptMessage); },
        secret: async () => { throw new Error(nonInteractivePromptMessage); }
      },
      writeConfig: () => { configWritten = true; }
    });

    expect(result).toBe(1);
    expect(errors).toEqual([nonInteractivePromptMessage]);
    expect(configWritten).toBe(false);
  });
});
