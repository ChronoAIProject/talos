import { describe, expect, it } from 'vitest';
import { testTestingInputReferences } from '../test-support/testing-placement.js';
import { StaticTestingPlacementInputVerifier } from './testing-placement-verifier.js';

const config = {
  schema_version: 'talos.testing-placement-verifier/v1',
  verifier_id: 'fixture-verifier',
  approved_inputs: [{
    verification_id: 'fixture-inputs',
    caller_user_ids: ['approved-user'],
    caller_groups: ['approved-group'],
    inputs: testTestingInputReferences('repo-1')
  }]
} as const;

describe('StaticTestingPlacementInputVerifier', () => {
  it('verifies one complete caller-bound provenance input set', async () => {
    const verifier = new StaticTestingPlacementInputVerifier(config);
    await expect(verifier.verify({
      callerUserId: 'approved-user',
      callerGroups: [],
      inputs: testTestingInputReferences('repo-1')
    })).resolves.toMatchObject({
      schemaVersion: 'talos.testing-placement-input-verification/v1',
      verifierId: 'fixture-verifier',
      verificationId: 'fixture-inputs',
      caller: { type: 'user', value: 'approved-user' },
      verificationDigest: expect.stringMatching(/^sha256:/)
    });
  });

  it('rejects caller, Source, Plan, or Profile drift and malformed verifier entries', async () => {
    const verifier = new StaticTestingPlacementInputVerifier(config);
    const approved = testTestingInputReferences('repo-1');
    const contexts = [
      { callerUserId: 'denied-user', callerGroups: [], inputs: approved },
      {
        callerUserId: 'approved-user',
        callerGroups: [],
        inputs: { ...approved, source_revision: { ...approved.source_revision, repository_id: 'repo-other' } }
      },
      {
        callerUserId: 'approved-user',
        callerGroups: [],
        inputs: {
          ...approved,
          structured_plan: { ...approved.structured_plan, digest: `sha256:${'b'.repeat(64)}` }
        }
      },
      {
        callerUserId: 'approved-user',
        callerGroups: [],
        inputs: {
          ...approved,
          environment_profile: { ...approved.environment_profile, ref: 'artifact://environments/other' }
        }
      }
    ];
    for (const context of contexts) await expect(verifier.verify(context)).resolves.toBeUndefined();

    expect(() => new StaticTestingPlacementInputVerifier({
      ...config,
      approved_inputs: [{ ...config.approved_inputs[0], caller_user_ids: [], caller_groups: [] }]
    })).toThrow('verified placement input requires at least one caller user or group');
    expect(() => new StaticTestingPlacementInputVerifier({
      ...config,
      approved_inputs: [config.approved_inputs[0], config.approved_inputs[0]]
    })).toThrow('placement verification_id must be unique');
  });
});
