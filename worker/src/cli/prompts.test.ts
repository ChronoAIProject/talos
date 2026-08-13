import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompter, nonInteractivePromptMessage } from './prompts.js';

describe('worker CLI prompter', () => {
  it('rejects with actionable guidance when stdin closes before an answer', async () => {
    const input = Readable.from([]);
    const output = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const prompter = createPrompter(input, output);

    await expect(prompter.text('Profile path')).rejects.toThrow(nonInteractivePromptMessage);
  });
});
