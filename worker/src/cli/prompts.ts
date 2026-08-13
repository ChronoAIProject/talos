import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface Prompter {
  text(label: string, defaultValue?: string): Promise<string>;
  secret(label: string): Promise<string>;
}

export const nonInteractivePromptMessage = 'stdin is not interactive; supply --profile-path (and any other missing flags) for non-interactive init';

export const createPrompter = (
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Prompter => ({
  text: async (label, defaultValue) => {
    const suffix = defaultValue === undefined ? ': ' : ` [${defaultValue}]: `;
    const answer = await question(input, output, `${label}${suffix}`);
    return answer.length === 0 && defaultValue !== undefined ? defaultValue : answer;
  },
  secret: async (label) => hiddenQuestion(input, output, `${label}: `)
});

const hiddenQuestion = async (input: Readable, output: Writable, label: string): Promise<string> => {
  assertInteractive(input);
  const terminal = createInterface({ input, output, terminal: true });
  const hiddenOutput = terminal as unknown as { _writeToOutput: (value: string) => void };
  hiddenOutput._writeToOutput = (value) => {
    if (value.includes(label)) output.write(label);
  };
  const answer = await ask(terminal, label);
  output.write('\n');
  return answer;
};

const question = async (input: Readable, output: Writable, label: string): Promise<string> => {
  assertInteractive(input);
  return ask(createInterface({ input, output }), label);
};

const ask = async (terminal: Interface, label: string): Promise<string> => {
  try {
    return await new Promise<string>((resolve, reject) => {
      let answered = false;
      terminal.once('close', () => {
        if (!answered) reject(new Error(nonInteractivePromptMessage));
      });
      terminal.question(label, (answer) => {
        answered = true;
        resolve(answer);
      });
    });
  } finally {
    terminal.close();
  }
};

const assertInteractive = (input: Readable): void => {
  const candidate = input as Readable & { isTTY?: boolean };
  if (
    input.destroyed ||
    input.readableEnded ||
    candidate.isTTY === false ||
    (input === process.stdin && process.stdin.isTTY !== true)
  ) {
    throw new Error(nonInteractivePromptMessage);
  }
};
