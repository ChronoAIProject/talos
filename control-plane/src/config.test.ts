import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { testTestingInputReferences } from './test-support/testing-placement.js';

describe('configuration', () => {
  it('fails fast and parses required startup values', () => {
    expect(() => loadConfig({})).toThrow('invalid Talos configuration');
    expect(loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456' })).toMatchObject({ port: 8080, sweepIntervalMs: 10000 });
    expect(loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'mongodb://talos:secret@db:27017/talos' })).toMatchObject({ databaseUrl: 'mongodb://talos:secret@db:27017/talos', databaseName: 'talos' });
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'not-a-url' })).toThrow('invalid Talos configuration');
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_DATABASE_URL: 'https://not-mongodb.example' })).toThrow('invalid Talos configuration');
    expect(loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_NYXID_JWKS_URL: 'https://nyxid.example/.well-known/jwks.json', TALOS_NYXID_ISSUER: 'https://nyxid.example', TALOS_NYXID_AUDIENCE: 'talos' })).toMatchObject({ nyxidJwksUrl: 'https://nyxid.example/.well-known/jwks.json', nyxidIssuer: 'https://nyxid.example', nyxidAudience: 'talos' });
    expect(loadConfig({
      TALOS_WEBHOOK_SECRET: 'webhook-secret-1234',
      TALOS_ADMIN_TOKEN: 'admin-token-123456',
      TALOS_TESTING_CLAIM_PRIVATE_KEY: 'pem-private-key',
      TALOS_TESTING_CLAIM_KEY_ID: 'testing-claim-key-1'
    })).toMatchObject({
      testingClaimPrivateKey: 'pem-private-key',
      testingClaimKeyId: 'testing-claim-key-1'
    });
    const placementPolicy = JSON.stringify({
      schema_version: 'talos.testing-placement-policy/v1',
      policy_id: 'qa-canary',
      rules: [{
        rule_id: 'approved',
        pool_id: 'qa-macos-canary',
        caller_user_ids: ['user-1'],
        repository_ids: ['repo-1'],
        environment_profiles: [{
          ref: 'artifact://environments/environment-1',
          digest: `sha256:${'a'.repeat(64)}`
        }],
        execution_policy: {
          ref: 'talos://policies/testing/policy-1',
          digest: `sha256:${'a'.repeat(64)}`
        },
        budgets: {
          ref: 'talos://policies/testing/budgets-1',
          digest: `sha256:${'a'.repeat(64)}`
        },
        testing_package: {
          package_id: 'testing-browser-runner',
          version: '1.0',
          digest: `sha256:${'a'.repeat(64)}`
        }
      }]
    });
    const placementVerifier = JSON.stringify({
      schema_version: 'talos.testing-placement-verifier/v1',
      verifier_id: 'qa-canary-verifier',
      approved_inputs: [{
        verification_id: 'approved-inputs',
        caller_user_ids: ['user-1'],
        inputs: testTestingInputReferences('repo-1')
      }]
    });
    expect(loadConfig({
      TALOS_WEBHOOK_SECRET: 'webhook-secret-1234',
      TALOS_ADMIN_TOKEN: 'admin-token-123456',
      TALOS_TESTING_PLACEMENT_POLICY: placementPolicy,
      TALOS_TESTING_PLACEMENT_VERIFIER: placementVerifier
    })).toMatchObject({
      testingPlacementPolicy: { policy_id: 'qa-canary' },
      testingPlacementVerifier: { verifier_id: 'qa-canary-verifier' }
    });
    expect(() => loadConfig({
      TALOS_WEBHOOK_SECRET: 'webhook-secret-1234',
      TALOS_ADMIN_TOKEN: 'admin-token-123456',
      TALOS_TESTING_PLACEMENT_POLICY: '{invalid'
    })).toThrow('invalid Talos configuration');
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_NYXID_JWKS_URL: 'https://nyxid.example/jwks' })).toThrow('invalid Talos configuration');
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_NYXID_JWKS_URL: 'https://nyxid.example/jwks', TALOS_NYXID_JWT_PUBLIC_KEY: 'pem', TALOS_NYXID_ISSUER: 'i', TALOS_NYXID_AUDIENCE: 'a' })).toThrow('invalid Talos configuration');
    expect(() => loadConfig({ TALOS_WEBHOOK_SECRET: 'webhook-secret-1234', TALOS_ADMIN_TOKEN: 'admin-token-123456', TALOS_NYXID_ISSUER: 'https://nyxid.example' })).toThrow('invalid Talos configuration');
  });
});
