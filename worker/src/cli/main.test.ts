import { describe, expect, it } from 'vitest';
import { runCli } from './main.js';

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
});
