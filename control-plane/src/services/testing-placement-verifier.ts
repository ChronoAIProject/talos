import {
  canonicalJson,
  digestJson,
  testingInputReferencesSchema,
  type TestingInputReferences
} from '@talos/testing-protocol';
import { z } from 'zod';

const identifier = z.string().trim().min(1).max(255);

export const staticTestingPlacementVerifierConfigSchema = z.object({
  schema_version: z.literal('talos.testing-placement-verifier/v1'),
  verifier_id: identifier,
  approved_inputs: z.array(z.object({
    verification_id: identifier,
    caller_user_ids: z.array(identifier).max(100).default([]),
    caller_groups: z.array(identifier).max(100).default([]),
    inputs: testingInputReferencesSchema
  }).strict().refine(
    (entry) => entry.caller_user_ids.length > 0 || entry.caller_groups.length > 0,
    'verified placement input requires at least one caller user or group'
  )).min(1).max(100)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, entry] of value.approved_inputs.entries()) {
    if (ids.has(entry.verification_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'placement verification_id must be unique',
        path: ['approved_inputs', index, 'verification_id']
      });
    }
    ids.add(entry.verification_id);
  }
});

export type StaticTestingPlacementVerifierConfig = z.infer<typeof staticTestingPlacementVerifierConfigSchema>;

export interface TestingPlacementVerificationContext {
  readonly callerUserId: string;
  readonly callerGroups: readonly string[];
  readonly inputs: TestingInputReferences;
}

export interface VerifiedTestingPlacementInputs {
  readonly schemaVersion: 'talos.testing-placement-input-verification/v1';
  readonly verifierId: string;
  readonly verificationId: string;
  readonly verificationDigest: string;
  readonly caller: {
    readonly type: 'user' | 'group';
    readonly value: string;
  };
  readonly inputs: TestingInputReferences;
}

export interface TestingPlacementInputVerifier {
  verify(context: TestingPlacementVerificationContext): Promise<VerifiedTestingPlacementInputs | undefined>;
}

export class StaticTestingPlacementInputVerifier implements TestingPlacementInputVerifier {
  private readonly config: StaticTestingPlacementVerifierConfig;

  public constructor(input: unknown) {
    this.config = staticTestingPlacementVerifierConfigSchema.parse(input);
  }

  public async verify(
    context: TestingPlacementVerificationContext
  ): Promise<VerifiedTestingPlacementInputs | undefined> {
    for (const approved of this.config.approved_inputs) {
      const matchedUser = approved.caller_user_ids.includes(context.callerUserId);
      const matchedGroup = [...context.callerGroups]
        .sort()
        .find((group) => approved.caller_groups.includes(group));
      if (!matchedUser && matchedGroup === undefined) continue;
      if (canonicalJson(approved.inputs) !== canonicalJson(context.inputs)) continue;
      const verification = {
        schema_version: 'talos.testing-placement-input-verification/v1' as const,
        verifier_id: this.config.verifier_id,
        verification_id: approved.verification_id,
        caller: matchedUser
          ? { type: 'user' as const, value: context.callerUserId }
          : { type: 'group' as const, value: matchedGroup as string },
        inputs: approved.inputs
      };
      return {
        schemaVersion: verification.schema_version,
        verifierId: verification.verifier_id,
        verificationId: verification.verification_id,
        verificationDigest: digestJson(verification),
        caller: verification.caller,
        inputs: approved.inputs
      };
    }
    return undefined;
  }
}
