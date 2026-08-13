import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('configuration', () => {
  it('fails fast and parses required startup values', () => {
    expect(() => loadConfig({})).toThrow('invalid Talos configuration');
    expect(loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456' })).toMatchObject({ port: 8080, sweepIntervalMs: 10000 });
    expect(loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'mongodb://talos:secret@db:27017/talos' })).toMatchObject({ databaseUrl: 'mongodb://talos:secret@db:27017/talos', databaseName: 'talos' });
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'not-a-url' })).toThrow('invalid Talos configuration');
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'https://not-mongodb.example' })).toThrow('invalid Talos configuration');
    expect(loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_NYXID_JWKS_URL: 'https://nyxid.example/.well-known/jwks.json', TALOS_NYXID_ISSUER: 'https://nyxid.example', TALOS_NYXID_AUDIENCE: 'talos' })).toMatchObject({ nyxidJwksUrl: 'https://nyxid.example/.well-known/jwks.json', nyxidIssuer: 'https://nyxid.example', nyxidAudience: 'talos' });
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_NYXID_JWKS_URL: 'https://nyxid.example/jwks' })).toThrow('invalid Talos configuration');
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_NYXID_JWKS_URL: 'https://nyxid.example/jwks', TALOS_NYXID_JWT_PUBLIC_KEY: 'pem', TALOS_NYXID_ISSUER: 'i', TALOS_NYXID_AUDIENCE: 'a' })).toThrow('invalid Talos configuration');
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_NYXID_ISSUER: 'https://nyxid.example' })).toThrow('invalid Talos configuration');
  });
});
