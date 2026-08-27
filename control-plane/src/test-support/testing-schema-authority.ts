import type {
  TestingExternalSchemaAuthority,
  TestingExternalSchemaReferenceVerification,
  TestingTerminalSchemaContract
} from '../services/testing-schema-authority.js';

const defaultDigest = `sha256:${'a'.repeat(64)}`;

const identities = {
  action: { schema_id: 'testing-action', version: 'v2' },
  observation: { schema_id: 'testing-observation', version: 'v2' },
  assertion: { schema_id: 'testing-assertion', version: 'v2' },
  case_result_set: { schema_id: 'testing-case-result-set', version: 'v2' },
  evidence_manifest: { schema_id: 'testing-evidence-manifest', version: 'v1' },
  cleanup_receipt: { schema_id: 'qa.local-cleanup-receipt', version: 'v2' }
} as const;

const referenceSchemas: Record<TestingTerminalSchemaContract, string> = {
  case_result_set: 'testing-case-result-set.v2',
  evidence_manifest: 'testing-evidence-manifest.v1',
  cleanup_receipt: 'qa.local-cleanup-receipt/v2'
};

export const testTestingExternalSchemaAuthority = (
  schemaDigest = defaultDigest
): TestingExternalSchemaAuthority => ({
  getCapabilities: async () => ([
    capability('action', 'testing-packages', schemaDigest),
    capability('observation', 'testing-packages', schemaDigest),
    capability('assertion', 'testing-packages', schemaDigest),
    capability('case_result_set', 'testing-packages', schemaDigest),
    capability('evidence_manifest', 'local-qa-runtime', schemaDigest),
    capability('cleanup_receipt', 'local-qa-runtime', schemaDigest)
  ]),
  verifyTerminalReference: async (contract, owner, reference) => {
    const identity = identities[contract];
    const expectedOwner = contract === 'case_result_set' ? 'testing-packages' : 'local-qa-runtime';
    if (
      owner !== expectedOwner ||
      reference.schema !== referenceSchemas[contract] ||
      reference.schema_digest !== schemaDigest
    ) return undefined;
    const verification: TestingExternalSchemaReferenceVerification = {
      schemaVersion: 'talos.testing-external-schema-verification/v1',
      authorityId: 'test-upstream-schema-authority',
      verificationId: `test-schema-verification-${contract}`,
      contract,
      owner,
      referenceSchema: reference.schema,
      schemaId: identity.schema_id,
      version: identity.version,
      schemaDigest,
      artifactRef: reference.ref,
      artifactDigest: reference.digest,
      verifiedAt: '2026-08-22T00:00:00.000Z'
    };
    return verification;
  }
});

const capability = (
  contract: keyof typeof identities,
  owner: 'testing-packages' | 'local-qa-runtime',
  digest: string
) => ({
  contract,
  owner,
  source: 'upstream_manifest' as const,
  status: 'available' as const,
  schemas: [{ ...identities[contract], digest }],
  reason_code: null
});
