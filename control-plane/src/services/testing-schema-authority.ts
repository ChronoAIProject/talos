import {
  testingExternalSchemaCapabilitySchema,
  type TestingExternalSchemaCapability,
  type TestingTerminalRefs
} from '@talos/testing-protocol';

export const TESTING_EXTERNAL_SCHEMA_OWNERS = [
  ['action', 'testing-packages'],
  ['observation', 'testing-packages'],
  ['assertion', 'testing-packages'],
  ['case_result_set', 'testing-packages'],
  ['evidence_manifest', 'local-qa-runtime'],
  ['cleanup_receipt', 'local-qa-runtime']
] as const;

export type TestingExternalSchemaContract = typeof TESTING_EXTERNAL_SCHEMA_OWNERS[number][0];
export type TestingExternalSchemaOwner = typeof TESTING_EXTERNAL_SCHEMA_OWNERS[number][1];
export type TestingTerminalSchemaContract = Extract<
  TestingExternalSchemaContract,
  'case_result_set' | 'evidence_manifest' | 'cleanup_receipt'
>;
export type TestingTerminalExternalReference = NonNullable<
  TestingTerminalRefs[TestingTerminalSchemaContract]
>;

export interface TestingExternalSchemaReferenceVerification {
  readonly schemaVersion: 'talos.testing-external-schema-verification/v1';
  readonly authorityId: string;
  readonly verificationId: string;
  readonly contract: TestingTerminalSchemaContract;
  readonly owner: TestingExternalSchemaOwner;
  readonly referenceSchema: string;
  readonly schemaId: string;
  readonly version: string;
  readonly schemaDigest: string;
  readonly artifactRef: string;
  readonly artifactDigest: string;
  readonly verifiedAt: string;
}

export interface TestingExternalSchemaAuthority {
  getCapabilities(): Promise<readonly TestingExternalSchemaCapability[]>;
  verifyTerminalReference(
    contract: TestingTerminalSchemaContract,
    owner: TestingExternalSchemaOwner,
    reference: TestingTerminalExternalReference
  ): Promise<TestingExternalSchemaReferenceVerification | undefined>;
}

export const unavailableTestingExternalSchemaCapabilities = (
  reasonCode: 'upstream_schema_manifest_unpublished' | 'upstream_schema_manifest_unavailable'
): readonly TestingExternalSchemaCapability[] => TESTING_EXTERNAL_SCHEMA_OWNERS.map(([contract, owner]) => ({
  contract,
  owner,
  source: 'upstream_manifest',
  status: 'unavailable',
  schemas: [],
  reason_code: reasonCode
}));

export const resolveTestingExternalSchemaCapabilities = async (
  authority: TestingExternalSchemaAuthority | undefined
): Promise<readonly TestingExternalSchemaCapability[]> => {
  if (authority === undefined) {
    return unavailableTestingExternalSchemaCapabilities('upstream_schema_manifest_unpublished');
  }
  try {
    const capabilities = await authority.getCapabilities();
    if (capabilities.length !== TESTING_EXTERNAL_SCHEMA_OWNERS.length) throw new Error('incomplete schema capabilities');
    return capabilities.map((capability, index) => {
      const parsed = testingExternalSchemaCapabilitySchema.parse(capability);
      const expected = TESTING_EXTERNAL_SCHEMA_OWNERS[index];
      if (expected === undefined || parsed.contract !== expected[0] || parsed.owner !== expected[1]) {
        throw new Error('schema capabilities are out of canonical owner order');
      }
      return parsed;
    });
  } catch {
    return unavailableTestingExternalSchemaCapabilities('upstream_schema_manifest_unavailable');
  }
};
