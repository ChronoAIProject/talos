export interface Printer {
  out(message: string): void;
  error(message: string): void;
}

export const createPrinter = (): Printer => ({
  out: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`)
});
