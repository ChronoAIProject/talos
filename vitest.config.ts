import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['control-plane/src/**/*.test.ts', 'worker/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
      include: ['control-plane/src/**/*.ts', 'worker/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/domain/types.ts',
        '**/storage/repository.ts',
        '**/util/logger.ts',
        '**/executor/executor.ts',
        '**/executor/browser-executor.ts',
        '**/runtime/http-client.ts',
        '**/config.ts'
      ]
    }
  }
});
