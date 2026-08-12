import { loadConfig } from './config.js';
import { createApiServer } from './http/server.js';
import { ProfileLockService } from './services/profile-lock.js';
import { Scheduler } from './services/scheduler.js';
import { TaskService } from './services/task-service.js';
import { WebhookSigner } from './services/webhook-signer.js';
import { MemoryRepository } from './storage/memory-repository.js';

export const createControlPlane = (repository = new MemoryRepository(), webhookSecret = process.env.TALOS_WEBHOOK_SECRET): ReturnType<typeof createApiServer> => {
  if (webhookSecret === undefined || webhookSecret.length < 16) throw new Error('TALOS_WEBHOOK_SECRET must be provided and at least 16 characters');
  const scheduler = new Scheduler(repository);
  const profiles = new ProfileLockService(repository);
  const service = new TaskService(repository, scheduler, profiles, new WebhookSigner(webhookSecret));
  return createApiServer(service, repository);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  createControlPlane(undefined, config.webhookSecret).listen(config.port);
}

export * from './domain/types.js';
export * from './domain/schemas.js';
export * from './domain/errors.js';
export * from './services/task-service.js';
export * from './services/scheduler.js';
export * from './services/profile-lock.js';
export * from './services/webhook-signer.js';
export * from './storage/memory-repository.js';
export * from './storage/repository.js';
export * from './http/server.js';
