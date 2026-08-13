import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

export interface Prompter {
  text(label: string, defaultValue?: string): Promise<string>;
  secret(label: string): Promise<string>;
}

export const createPrompter = (
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Prompter => ({
  text: async (label, defaultValue) => {
    const terminal = createInterface({ input, output });
    const suffix = defaultValue === undefined ? ': ' : ` [${defaultValue}]: `;
    const answer = await terminal.question(`${label}${suffix}`);
    terminal.close();
    return answer.length === 0 && defaultValue !== undefined ? defaultValue : answer;
  },
  secret: async (label) => hiddenQuestion(input, output, `${label}: `)
});

const hiddenQuestion = async (input: Readable, output: Writable, label: string): Promise<string> => {
  const terminal = createInterface({ input, output, terminal: true });
  const hiddenOutput = terminal as unknown as { _writeToOutput: (value: string) => void };
  hiddenOutput._writeToOutput = (value) => {
    if (value.includes(label)) output.write(label);
  };
  const answer = await terminal.question(label);
  terminal.close();
  output.write('\n');
  return answer;
};
