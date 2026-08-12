import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('configuration', () => {
  it('fails fast and parses required startup values', () => {
    expect(() => loadConfig({})).toThrow('invalid Talos configuration');
    expect(loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456' })).toMatchObject({ port: 8080, sweepIntervalMs: 10000 });
    expect(loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'postgres://talos:secret@db:5432/talos' })).toMatchObject({ databaseUrl: 'postgres://talos:secret@db:5432/talos' });
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'not-a-url' })).toThrow('invalid Talos configuration');
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'https://not-postgres.example' })).toThrow('invalid Talos configuration');
  });
});
