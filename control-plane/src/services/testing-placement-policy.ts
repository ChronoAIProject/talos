import { z } from 'zod';
import type { TestingPlacementRecord } from '../domain/testing-types.js';
import type { VerifiedTestingPlacementInputs } from './testing-placement-verifier.js';

const identifier = z.string().trim().min(1).max(255);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const reference = z.object({ ref: z.string().trim().min(1).max(2048), digest }).strict();
const testingPackage = z.object({
  package_id: identifier,
  version: z.string().trim().min(1).max(255),
  digest
}).strict();

export const staticTestingPlacementPolicyConfigSchema = z.object({
  schema_version: z.literal('talos.testing-placement-policy/v1'),
  policy_id: identifier,
  rules: z.array(z.object({
    rule_id: identifier,
    pool_id: identifier,
    caller_user_ids: z.array(identifier).max(100).default([]),
    caller_groups: z.array(identifier).max(100).default([]),
    repository_ids: z.array(identifier).min(1).max(100),
    environment_profiles: z.array(z.object({
      ref: z.string().trim().min(1).max(2048),
      digest
    }).strict()).min(1).max(100),
    execution_policy: reference,
    budgets: reference,
    testing_package: testingPackage
  }).strict().refine(
    (rule) => rule.caller_user_ids.length > 0 || rule.caller_groups.length > 0,
    'placement rule requires at least one caller user or group'
  )).min(1).max(100)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, rule] of value.rules.entries()) {
    if (ids.has(rule.rule_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'placement rule_id must be unique',
        path: ['rules', index, 'rule_id']
      });
    }
    ids.add(rule.rule_id);
  }
});

export type StaticTestingPlacementPolicyConfig = z.infer<typeof staticTestingPlacementPolicyConfigSchema>;

export interface TestingPlacementContext {
  readonly callerUserId: string;
  readonly callerGroups: readonly string[];
  readonly verifiedInputs: VerifiedTestingPlacementInputs;
  readonly executionPolicy: { readonly ref: string; readonly digest: string };
  readonly budgets: { readonly ref: string; readonly digest: string };
  readonly testingPackage: { readonly package_id: string; readonly version: string; readonly digest: string };
}

export interface TestingPlacementPolicy {
  select(context: TestingPlacementContext): Promise<Omit<TestingPlacementRecord, 'selectedAt'> | undefined>;
}

export class StaticTestingPlacementPolicy implements TestingPlacementPolicy {
  private readonly config: StaticTestingPlacementPolicyConfig;

  public constructor(input: unknown) {
    this.config = staticTestingPlacementPolicyConfigSchema.parse(input);
  }

  public async select(
    context: TestingPlacementContext
  ): Promise<Omit<TestingPlacementRecord, 'selectedAt'> | undefined> {
    const repositoryId = context.verifiedInputs.inputs.source_revision.repository_id;
    const environmentProfile = context.verifiedInputs.inputs.environment_profile;
    for (const rule of this.config.rules) {
      const matchedUser = rule.caller_user_ids.includes(context.callerUserId);
      const matchedGroup = [...context.callerGroups]
        .sort()
        .find((group) => rule.caller_groups.includes(group));
      if (!matchedUser && matchedGroup === undefined) continue;
      if (!rule.repository_ids.includes(repositoryId)) continue;
      const profile = rule.environment_profiles.find((candidate) =>
        candidate.ref === environmentProfile.ref &&
        candidate.digest === environmentProfile.digest);
      if (profile === undefined) continue;
      if (rule.execution_policy.ref !== context.executionPolicy.ref ||
        rule.execution_policy.digest !== context.executionPolicy.digest) continue;
      if (rule.budgets.ref !== context.budgets.ref || rule.budgets.digest !== context.budgets.digest) continue;
      if (rule.testing_package.package_id !== context.testingPackage.package_id ||
        rule.testing_package.version !== context.testingPackage.version ||
        rule.testing_package.digest !== context.testingPackage.digest) continue;
      return {
        schemaVersion: 'talos.testing-placement-decision/v1',
        policyId: this.config.policy_id,
        ruleId: rule.rule_id,
        poolId: rule.pool_id,
        caller: matchedUser
          ? { type: 'user', value: context.callerUserId }
          : { type: 'group', value: matchedGroup as string },
        repositoryId,
        environmentProfile: profile,
        inputVerification: {
          schemaVersion: context.verifiedInputs.schemaVersion,
          verifierId: context.verifiedInputs.verifierId,
          verificationId: context.verifiedInputs.verificationId,
          verificationDigest: context.verifiedInputs.verificationDigest
        },
        executionPolicy: rule.execution_policy,
        budgets: rule.budgets,
        testingPackage: {
          packageId: rule.testing_package.package_id,
          version: rule.testing_package.version,
          digest: rule.testing_package.digest
        },
        capability: {
          testingRuntime: 'local-qa-mvp/v1',
          taskContract: 'talos.testing-task/v1',
          backend: 'browser',
          browser: 'chromium',
          os: 'darwin',
          arch: 'arm64',
          headedDisplay: true,
          maxTestingConcurrency: 1
        }
      };
    }
    return undefined;
  }
}
