import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['testing-protocol/src/**/*.test.ts', 'control-plane/src/**/*.test.ts', 'worker/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
      include: ['testing-protocol/src/**/*.ts', 'control-plane/src/**/*.ts', 'worker/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/domain/types.ts',
        '**/storage/repository.ts',
        '**/executor/executor.ts',
        '**/testing-protocol/src/index.ts',
        '**/worker/src/index.ts'
      ]
    }
  }
});
