import type { TestingExecutionDependencyReadiness } from '../services/testing-run-service.js';

export const testTestingExecutionDependencyReadiness = (): TestingExecutionDependencyReadiness => ({
  persistentClaimSigningKey: true,
  authorizationProvider: true,
  runtimeFactVerifier: true,
  cleanupReceiptVerifier: true
});
