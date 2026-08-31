import { describe, expect, it } from 'vitest';
import { StaticTestingPlacementPolicy } from './testing-placement-policy.js';
import {
  testTestingInputReferences,
  testTestingPlacementInputVerifier
} from '../test-support/testing-placement.js';

const digest = `sha256:${'a'.repeat(64)}`;
const config = {
  schema_version: 'talos.testing-placement-policy/v1',
  policy_id: 'qa-canary-policy',
  rules: [{
    rule_id: 'approved-project-profile',
    pool_id: 'qa-macos-canary',
    caller_user_ids: ['approved-user'],
    caller_groups: ['qa-engineering'],
    repository_ids: ['repo-approved'],
    environment_profiles: [{ ref: 'artifact://environments/approved', digest }],
    execution_policy: { ref: 'talos://policies/testing/approved', digest },
    budgets: { ref: 'talos://policies/testing/approved-budgets', digest },
    testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
  }]
} as const;

const verifiedInputs = async () => {
  const verified = await testTestingPlacementInputVerifier().verify({
    callerUserId: 'user-1',
    callerGroups: [],
    inputs: testTestingInputReferences('repo-1')
  });
  if (verified === undefined) throw new Error('verified placement fixture missing');
  return {
    ...verified,
    inputs: {
      ...verified.inputs,
      source_revision: { ...verified.inputs.source_revision, repository_id: 'repo-approved' },
      environment_profile: { ref: 'artifact://environments/approved', digest }
    }
  };
};

const context = async (overrides: Readonly<Record<string, unknown>> = {}) => ({
  callerUserId: 'approved-user',
  callerGroups: [] as readonly string[],
  verifiedInputs: await verifiedInputs(),
  executionPolicy: { ref: 'talos://policies/testing/approved', digest },
  budgets: { ref: 'talos://policies/testing/approved-budgets', digest },
  testingPackage: { package_id: 'testing-browser-runner', version: '1.0', digest },
  ...overrides
});

describe('StaticTestingPlacementPolicy', () => {
  it('matches exact caller, repository, and Environment Profile bindings', async () => {
    const policy = new StaticTestingPlacementPolicy(config);
    await expect(policy.select(await context())).resolves.toMatchObject({
      policyId: 'qa-canary-policy',
      ruleId: 'approved-project-profile',
      poolId: 'qa-macos-canary',
      caller: { type: 'user', value: 'approved-user' }
    });
    await expect(policy.select(await context({
      callerUserId: 'another-user',
      callerGroups: ['qa-engineering']
    }))).resolves.toMatchObject({ caller: { type: 'group', value: 'qa-engineering' } });
  });

  it('fails closed for any unmatched binding and malformed broad rules', async () => {
    const policy = new StaticTestingPlacementPolicy(config);
    await expect(policy.select(await context({ callerUserId: 'unapproved' }))).resolves.toBeUndefined();
    await expect(policy.select(await context({
      executionPolicy: { ref: 'talos://policies/testing/other', digest }
    }))).resolves.toBeUndefined();
    await expect(policy.select(await context({
      testingPackage: { package_id: 'other-runner', version: '1.0', digest }
    }))).resolves.toBeUndefined();
    expect(() => new StaticTestingPlacementPolicy({
      ...config,
      rules: [{ ...config.rules[0], caller_user_ids: [], caller_groups: [] }]
    })).toThrow('placement rule requires at least one caller user or group');
    expect(() => new StaticTestingPlacementPolicy({
      ...config,
      rules: [config.rules[0], config.rules[0]]
    })).toThrow('placement rule_id must be unique');
  });
});
