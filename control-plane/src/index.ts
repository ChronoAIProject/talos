import { loadConfig } from './config.js';
import { createApiServer } from './http/server.js';
import { ProfileLockService } from './services/profile-lock.js';
import { Scheduler } from './services/scheduler.js';
import { TaskService } from './services/task-service.js';
import { WebhookSigner } from './services/webhook-signer.js';
import { WebhookDispatcher, type WebhookDispatcherOptions } from './services/webhook-dispatcher.js';
import { MemoryRepository } from './storage/memory-repository.js';
import { MongoRepository } from './storage/mongo-repository.js';
import type { Repository } from './storage/repository.js';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { KeyObject } from 'node:crypto';
import { createLogger } from './util/logger.js';
import { DevIdentityResolver, JwtIdentityResolver, type IdentityResolver } from './identity.js';
import { loadOpenApiDocument } from './openapi.js';
import { TestingRunService } from './services/testing-run-service.js';
import {
  TestingAttemptService,
  type TestingAuthorizationProvider,
  type TestingRuntimeFactVerifier
} from './services/testing-attempt-service.js';
import {
  StaticTestingPlacementPolicy,
  type TestingPlacementPolicy
} from './services/testing-placement-policy.js';
import {
  StaticTestingPlacementInputVerifier,
  type TestingPlacementInputVerifier
} from './services/testing-placement-verifier.js';

export interface ControlPlaneServer extends Server { stopSweep(): void; repository: Repository; }

export const createRepository = (databaseUrl = process.env.TALOS_DATABASE_URL, databaseName = process.env.TALOS_DATABASE_NAME ?? 'talos'): Repository => {
  if (databaseUrl !== undefined) return new MongoRepository(databaseUrl, databaseName);
  createLogger().warn('using in-memory repository; state is ephemeral and lost on restart');
  return new MemoryRepository();
};

export const createControlPlane = (
  repository = createRepository(),
  webhookSecret = process.env.TALOS_WEBHOOK_SECRET,
  options: {
    adminToken?: string;
    identityResolver?: IdentityResolver;
    sweepIntervalMs?: number;
    webhook?: Omit<WebhookDispatcherOptions, 'clock'>;
    openApiPath?: string;
    testingAuthorizationProvider?: TestingAuthorizationProvider;
    testingRuntimeFactVerifier?: TestingRuntimeFactVerifier;
    testingClaimSigningKey?: KeyObject | string;
    testingClaimKeyId?: string;
    testingPlacementPolicy?: TestingPlacementPolicy;
    testingPlacementInputVerifier?: TestingPlacementInputVerifier;
  } = {}
): ControlPlaneServer => {
  if (webhookSecret === undefined || webhookSecret.length < 16) throw new Error('TALOS_WEBHOOK_SECRET must be provided and at least 16 characters');
  const scheduler = new Scheduler(repository);
  const profiles = new ProfileLockService(repository);
  const signer = new WebhookSigner(webhookSecret);
  const dispatcher = new WebhookDispatcher(repository, signer, options.webhook);
  const logger = createLogger();
  const openApiDocument = loadOpenApiDocument(options.openApiPath);
  const service = new TaskService(repository, scheduler, profiles, signer, {
    validateCallback: (callback) => dispatcher.validateCallback(callback),
    onWebhook: (event, signed, callback) => dispatcher.dispatch(event, callback, signed),
    logger
  });
  const testingRuns = new TestingRunService(repository, {
    cursorSecret: webhookSecret,
    clock: Date.now,
    placementPolicy: options.testingPlacementPolicy,
    placementInputVerifier: options.testingPlacementInputVerifier
  });
  const testingClaimSigningKey = options.testingClaimSigningKey ?? process.env.TALOS_TESTING_CLAIM_PRIVATE_KEY;
  if (testingClaimSigningKey === undefined) {
    logger.warn('testing claim signing key is not configured; using a development-only ephemeral Ed25519 key');
  }
  const testingAttempts = new TestingAttemptService(repository, {
    claimSigningKey: testingClaimSigningKey,
    claimKeyId: options.testingClaimKeyId ?? process.env.TALOS_TESTING_CLAIM_KEY_ID,
    authorizationProvider: options.testingAuthorizationProvider,
    runtimeFactVerifier: options.testingRuntimeFactVerifier,
    clock: Date.now
  });
  const server = createApiServer(service, repository, {
    adminToken: options.adminToken ?? process.env.TALOS_ADMIN_TOKEN,
    identityResolver: options.identityResolver,
    openApiDocument,
    testingRunService: testingRuns,
    testingAttemptService: testingAttempts,
    clock: Date.now
  }) as ControlPlaneServer;
  server.repository = repository;
  server.on('close', () => { void repository.close(); });
  let sweepInFlight = false;
  const sweep = async (): Promise<void> => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      try {
        await service.expireLeases();
      } catch (error) {
        logger.error('task lease sweep failed', { error: errorMessage(error) });
      }
      try {
        await testingAttempts.sweep();
      } catch (error) {
        logger.error('testing attempt sweep failed', { error: errorMessage(error) });
      }
    } finally {
      sweepInFlight = false;
    }
  };
  const interval = setInterval(() => { void sweep(); }, options.sweepIntervalMs ?? 10000);
  interval.unref();
  server.stopSweep = (): void => clearInterval(interval);
  return server;
};

/* c8 ignore next: process entrypoint branch is exercised by the deployed process, not unit imports. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const repository = createRepository(config.databaseUrl, config.databaseName);
  if (repository instanceof MongoRepository) await repository.initialize();
  const identityResolver = config.nyxidJwtPublicKey !== undefined || config.nyxidJwksUrl !== undefined
    ? new JwtIdentityResolver({
        publicKey: config.nyxidJwtPublicKey,
        jwksUrl: config.nyxidJwksUrl,
        issuer: config.nyxidIssuer as string,
        audience: config.nyxidAudience as string
      })
    : (() => {
        createLogger().warn('NyxID JWT verification is not configured; using the development-only identity stub');
        return new DevIdentityResolver();
      })();
  const server = createControlPlane(repository, config.webhookSecret, {
    adminToken: config.adminToken,
    sweepIntervalMs: config.sweepIntervalMs,
    identityResolver,
    testingClaimSigningKey: config.testingClaimPrivateKey,
    testingClaimKeyId: config.testingClaimKeyId,
    testingPlacementPolicy: config.testingPlacementPolicy === undefined
      ? undefined
      : new StaticTestingPlacementPolicy(config.testingPlacementPolicy),
    testingPlacementInputVerifier: config.testingPlacementVerifier === undefined
      ? undefined
      : new StaticTestingPlacementInputVerifier(config.testingPlacementVerifier)
  });
  const shutdown = (): void => {
    server.stopSweep();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(config.port);
}

export * from './domain/types.js';
export * from './domain/testing-types.js';
export * from './domain/schemas.js';
export * from './domain/errors.js';
export * from './services/task-service.js';
export * from './services/testing-run-service.js';
export * from './services/testing-attempt-service.js';
export * from './services/testing-placement-policy.js';
export * from './services/testing-placement-verifier.js';
export * from './services/session-service.js';
export * from './services/scheduler.js';
export * from './services/profile-lock.js';
export * from './services/webhook-signer.js';
export * from './services/webhook-dispatcher.js';
export * from './storage/memory-repository.js';
export * from './storage/mongo-repository.js';
export * from './storage/repository.js';
export * from './http/server.js';
export * from './http/testing-run-routes.js';
export * from './identity.js';
export * from './openapi.js';

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
