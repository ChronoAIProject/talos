#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { cliHelp, parseCliArguments } from './args.js';
import { initCommand, runCommand, serviceCommand, statusCommand, type CommandDependencies } from './commands.js';
import { createPrinter } from './printer.js';
import { createPrompter } from './prompts.js';

export const runCli = async (
  arguments_: readonly string[] = process.argv.slice(2),
  overrides: Partial<CommandDependencies> = {}
): Promise<number> => {
  const printer = overrides.printer ?? createPrinter();
  const dependencies: CommandDependencies = {
    printer,
    prompter: overrides.prompter ?? createPrompter(),
    ...overrides
  };
  try {
    const parsed = parseCliArguments(arguments_);
    if (parsed.command === 'help') printer.out(cliHelp.trimEnd());
    else if (parsed.command === 'init') await initCommand(parsed, dependencies);
    else if (parsed.command === 'run') await runCommand(dependencies);
    else if (parsed.command === 'status') await statusCommand(dependencies);
    else await serviceCommand(parsed.action, dependencies);
    return 0;
  } catch (error) {
    printer.error(error instanceof Error ? error.message : 'unexpected worker CLI error');
    return 1;
  }
};

/* c8 ignore next 4: process entrypoint delegates to the tested runCli function. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
