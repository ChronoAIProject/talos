import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['control-plane/src/**/*.test.ts', 'worker/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
      include: ['control-plane/src/**/*.ts', 'worker/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/domain/types.ts',
        '**/storage/repository.ts',
        '**/executor/executor.ts',
        '**/worker/src/index.ts'
      ]
    }
  }
});
