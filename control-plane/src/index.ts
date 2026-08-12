import { loadConfig } from './config.js';
import { createApiServer } from './http/server.js';
import { ProfileLockService } from './services/profile-lock.js';
import { Scheduler } from './services/scheduler.js';
import { TaskService } from './services/task-service.js';
import { WebhookSigner } from './services/webhook-signer.js';
import { WebhookDispatcher, type WebhookDispatcherOptions } from './services/webhook-dispatcher.js';
import { MemoryRepository } from './storage/memory-repository.js';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { createLogger } from './util/logger.js';

export interface ControlPlaneServer extends Server { stopSweep(): void; }

export const createControlPlane = (
  repository = new MemoryRepository(),
  webhookSecret = process.env.TALOS_WEBHOOK_SECRET,
  options: {
    adminToken?: string;
    sweepIntervalMs?: number;
    webhook?: Omit<WebhookDispatcherOptions, 'clock'>;
  } = {}
): ControlPlaneServer => {
  if (webhookSecret === undefined || webhookSecret.length < 16) throw new Error('TALOS_WEBHOOK_SECRET must be provided and at least 16 characters');
  const scheduler = new Scheduler(repository);
  const profiles = new ProfileLockService(repository);
  const signer = new WebhookSigner(webhookSecret);
  const dispatcher = new WebhookDispatcher(repository, signer, options.webhook);
  const logger = createLogger();
  const service = new TaskService(repository, scheduler, profiles, signer, {
    validateCallback: (callback) => dispatcher.validateCallback(callback),
    onWebhook: (event, signed, callback) => dispatcher.dispatch(event, callback, signed),
    logger
  });
  const server = createApiServer(service, repository, {
    adminToken: options.adminToken ?? process.env.TALOS_ADMIN_TOKEN,
    clock: Date.now
  }) as ControlPlaneServer;
  const interval = setInterval(() => {
    void service.expireLeases();
  }, options.sweepIntervalMs ?? 10000);
  interval.unref();
  server.stopSweep = (): void => clearInterval(interval);
  return server;
};

/* c8 ignore next: process entrypoint branch is exercised by the deployed process, not unit imports. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  createControlPlane(undefined, config.webhookSecret, { adminToken: config.adminToken, sweepIntervalMs: config.sweepIntervalMs }).listen(config.port);
}

export * from './domain/types.js';
export * from './domain/schemas.js';
export * from './domain/errors.js';
export * from './services/task-service.js';
export * from './services/scheduler.js';
export * from './services/profile-lock.js';
export * from './services/webhook-signer.js';
export * from './services/webhook-dispatcher.js';
export * from './storage/memory-repository.js';
export * from './storage/repository.js';
export * from './http/server.js';
