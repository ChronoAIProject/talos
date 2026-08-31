import type { Repository } from '../storage/repository.js';
import { StaticTestingPlacementPolicy } from '../services/testing-placement-policy.js';
import { StaticTestingPlacementInputVerifier } from '../services/testing-placement-verifier.js';
import {
  digestJson,
  testingInputReferencesSchema,
  type TestingInputReferences
} from '@talos/testing-protocol';

const digest = `sha256:${'a'.repeat(64)}`;
const executionPolicy = {
  network_scope: 'environment_owned_loopback_exact_origins',
  environment_port_handle_policy: {
    source: 'current_run_owned_handles',
    allow_unowned_loopback: false
  },
  allowed_actions: ['navigate'],
  allowed_evidence_media: ['image/png'],
  secret_refs: [],
  budgets: {
    wall_time_ms: 600_000,
    max_cases: 20,
    max_actions: 200,
    max_events: 2_000,
    max_screenshots: 20,
    max_screenshot_bytes: 5_242_880,
    max_json_evidence_bytes: 1_048_576,
    max_total_artifact_bytes: 52_428_800
  }
};

export const testTestingInputReferences = (repositoryId: string): TestingInputReferences =>
  testingInputReferencesSchema.parse({
  schema_version: 'talos.testing-input-references/v1',
  project_pack_snapshot: {
    schema: 'pql.project-pack-snapshot/v1',
    ref: 'artifact://pql/project-pack-snapshot/snapshot-1',
    digest
  },
  test_selection: {
    schema: 'pql.test-selection/v1',
    ref: 'artifact://pql/test-selection/selection-1',
    digest
  },
  testing_design_input_set: {
    schema: 'pql.testing-design-input-set.v1',
    ref: 'artifact://pql/testing-design-input-set/input-1',
    digest
  },
  source_revision: {
    repository_id: repositoryId,
    exact_revision: '0123456789abcdef0123456789abcdef01234567',
    ref: 'artifact://source/revision-1',
    digest
  },
  structured_plan: {
    schema: 'testing-structured-plan.v2',
    ref: 'artifact://plans/plan-1',
    digest
  },
  environment_profile: { ref: 'artifact://environments/environment-1', digest },
    testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
  });

export const testTestingPlacementPolicy = (poolId = 'testing-pool'): StaticTestingPlacementPolicy =>
  new StaticTestingPlacementPolicy({
    schema_version: 'talos.testing-placement-policy/v1',
    policy_id: 'test-canary-policy',
    rules: [{
      rule_id: 'test-canary-rule',
      pool_id: poolId,
      caller_user_ids: ['user-1'],
      caller_groups: ['eng'],
      repository_ids: ['repo-1', 'repo-example'],
      environment_profiles: [{ ref: 'artifact://environments/environment-1', digest }],
      execution_policy: {
        ref: 'talos://policies/testing/policy-1',
        digest: digestJson(executionPolicy)
      },
      budgets: {
        ref: 'talos://policies/testing/budgets-1',
        digest: digestJson(executionPolicy.budgets)
      },
      testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
    }]
  });

export const testTestingPlacementInputVerifier = (): StaticTestingPlacementInputVerifier =>
  new StaticTestingPlacementInputVerifier({
    schema_version: 'talos.testing-placement-verifier/v1',
    verifier_id: 'test-provenance-verifier',
    approved_inputs: ['repo-1', 'repo-example'].map((repositoryId) => ({
      verification_id: `approved-${repositoryId}`,
      caller_user_ids: ['user-1'],
      caller_groups: ['eng'],
      inputs: testTestingInputReferences(repositoryId)
    }))
  });

export const provisionTestingPool = async (
  repository: Repository,
  poolId = 'testing-pool'
): Promise<void> => {
  await repository.savePool({ id: poolId, visibility: 'platform', tags: {} });
  await repository.saveMachine({
    id: `${poolId}-configured-canary`,
    poolId,
    tags: {
      testing_runtime: 'local-qa-mvp/v1',
      testing_task_contract: 'talos.testing-task/v1',
      testing_backend: 'browser',
      browser: 'chromium',
      os: 'darwin',
      arch: 'arm64',
      headed_display: true,
      runner_package_id: 'testing-browser-runner',
      runner_package_version: '1.0',
      runner_package_digest: digest
    },
    capacity: 1,
    activeLeases: 0,
    online: false,
    workerTokenHash: 'test-only-worker-token-hash'
  });
};
