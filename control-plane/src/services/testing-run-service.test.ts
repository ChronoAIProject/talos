import { describe, expect, it } from 'vitest';
import {
  computeTestingCancelRequestDigest,
  digestJson,
  type TestingCancelRequest
} from '@talos/testing-protocol';
import { MemoryRepository } from '../storage/memory-repository.js';
import {
  TESTING_CANCEL_RECORD_RETENTION,
  TESTING_CURSOR_PAGE_RETENTION,
  TestingRunService,
  type TestingRunServiceOptions
} from './testing-run-service.js';
import {
  provisionTestingPool,
  testTestingPlacementInputVerifier,
  testTestingPlacementPolicy
} from '../test-support/testing-placement.js';
import type { TestingPlacementPolicy } from './testing-placement-policy.js';
import { submitTestingRun, testAuthenticatedTransportContext } from '../test-support/testing-transport.js';

const digest = `sha256:${'a'.repeat(64)}`;
const pointer = (schema: string, ref: string) => ({ schema, ref, digest });

const request = (key = 'submit-key') => {
  const policy = {
    network_scope: 'environment_owned_loopback_exact_origins' as const,
    environment_port_handle_policy: {
      source: 'current_run_owned_handles' as const,
      allow_unowned_loopback: false as const
    },
    allowed_actions: ['navigate' as const],
    allowed_evidence_media: ['image/png' as const],
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
  return {
    schema_version: 'talos.testing-tool-request/v1' as const,
    request_id: `request:${key}`,
    client_correlation_id: `client:${key}`,
    idempotency_key: key,
    display_goal: 'Verify login redirect',
    inputs: {
      schema_version: 'talos.testing-input-references/v1' as const,
      project_pack_snapshot: pointer('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/snapshot-1'),
      test_selection: pointer('pql.test-selection/v1', 'artifact://pql/test-selection/selection-1'),
      testing_design_input_set: pointer('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/input-1'),
      source_revision: {
        repository_id: 'repo-example',
        exact_revision: '0123456789abcdef0123456789abcdef01234567',
        ref: 'artifact://source/revision-1',
        digest
      },
      structured_plan: pointer('testing-structured-plan.v2', 'artifact://plans/plan-1'),
      environment_profile: { ref: 'artifact://environments/environment-1', digest },
      testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
    },
    execution_profile: 'local_qa_agent_mvp' as const,
    placement_requirements: { testing_runtime: 'local-qa-mvp/v1' as const },
    policy_binding: {
      policy: {
        schema: 'talos.testing-execution-policy/v1' as const,
        ref: 'talos://policies/testing/policy-1',
        digest: digestJson(policy)
      },
      budgets: {
        schema: 'talos.testing-budgets/v1' as const,
        ref: 'talos://policies/testing/budgets-1',
        digest: digestJson(policy.budgets)
      }
    },
    policy
  };
};

const cancelRequest = (
  runId: string,
  key: string,
  reason: TestingCancelRequest['reason'] = 'user_requested'
) => {
  const unsigned = {
    schema_version: 'talos.testing-cancel-request/v1' as const,
    idempotency_scope: `talos.testing.cancel:${runId}`,
    idempotency_key: key,
    reason
  };
  return {
    ...unsigned,
    canonical_request_digest: computeTestingCancelRequestDigest(runId, unsigned)
  };
};

const serviceFor = async (
  repository: MemoryRepository,
  options: Omit<TestingRunServiceOptions, 'placementPolicy'>
): Promise<TestingRunService> => {
  await provisionTestingPool(repository);
  return new TestingRunService(repository, {
    ...options,
    placementPolicy: testTestingPlacementPolicy(),
    placementInputVerifier: testTestingPlacementInputVerifier()
  });
};

describe('TestingRunService', () => {
  it('fails closed when the authenticated transport is not bound to caller, correlation, and request digest', async () => {
    const repository = new MemoryRepository();
    const service = await serviceFor(repository, {
      cursorSecret: 'testing-cursor-secret-123456'
    });
    const input = request('transport-binding-key');
    const context = testAuthenticatedTransportContext('run-transport-binding', input);

    await expect(service.submit('run-transport-binding', 'user-1', input, {
      ...context,
      subject: 'user-2'
    })).rejects.toMatchObject({ code: 'nyxid_subject_mismatch', status: 401 });
    await expect(service.submit('run-transport-binding', 'user-1', input, {
      ...context,
      route: { ...context.route, run_id: 'run-other' }
    })).rejects.toMatchObject({ code: 'nyxid_route_mismatch', status: 401 });
    await expect(service.submit('run-transport-binding', 'user-1', input, {
      ...context,
      authorization: { ...context.authorization, run_id: 'run-other' }
    })).rejects.toMatchObject({ code: 'nyxid_authorization_mismatch', status: 401 });
    await expect(service.submit('run-transport-binding', 'user-1', input, {
      ...context,
      authorization: { ...context.authorization, valid_until: '2026-08-21T23:59:59.000Z' }
    })).rejects.toMatchObject({ code: 'nyxid_authorization_expired', status: 401 });
    await expect(service.submit('run-transport-binding', 'user-1', input, {
      ...context,
      verified_client_correlation_id: 'client:other'
    })).rejects.toMatchObject({ code: 'nyxid_client_correlation_mismatch', status: 401 });
    await expect(service.submit('run-transport-binding', 'user-1', input, {
      ...context,
      verified_request_digest: `sha256:${'c'.repeat(64)}`
    })).rejects.toMatchObject({ code: 'nyxid_request_digest_mismatch', status: 401 });
    expect(await repository.getTestingRun('run-transport-binding')).toBeUndefined();
  });

  it('keeps the first verified admission lineage canonical across a valid idempotent transport retry', async () => {
    const repository = new MemoryRepository();
    const service = await serviceFor(repository, {
      cursorSecret: 'testing-cursor-secret-123456'
    });
    const input = request('transport-retry-key');
    const firstContext = testAuthenticatedTransportContext('run-transport-retry', input);
    const first = await service.submit('run-transport-retry', 'user-1', input, firstContext);
    const replay = await service.submit('run-transport-retry', 'user-1', input, {
      ...firstContext,
      transport_correlation_id: 'transport:run-transport-retry:second',
      transport_acknowledgement: {
        ...firstContext.transport_acknowledgement,
        ref: 'nyxid://transport-acks/testing/run-transport-retry-second'
      }
    });

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({
      created: false,
      acceptance: {
        replayed: true,
        authenticated_transport: { transport_correlation_id: firstContext.transport_correlation_id }
      }
    });
    expect((await repository.getTestingRun('run-transport-retry'))?.authenticatedTransport)
      .toEqual(firstContext);
  });

  it('atomically replays concurrent submit and rejects run/key identity conflicts before side effects', async () => {
    const repository = new MemoryRepository();
    const service = await serviceFor(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      clock: () => Date.parse('2026-08-22T00:00:00.000Z')
    });

    const submissions = await Promise.all(Array.from({ length: 20 }, () => submitTestingRun(service, 'run-1', 'user-1', request())));
    expect(submissions.filter((item) => item.created)).toHaveLength(1);
    expect(new Set(submissions.map((item) => item.acceptance.request_digest))).toHaveLength(1);
    expect(submissions.filter((item) => item.acceptance.replayed)).toHaveLength(19);
    expect(await repository.getTestingRun('run-1')).toMatchObject({
      placement: {
        schemaVersion: 'talos.testing-placement-decision/v1',
        policyId: 'test-canary-policy',
        ruleId: 'test-canary-rule',
        poolId: 'testing-pool',
        caller: { type: 'user', value: 'user-1' },
        repositoryId: 'repo-example',
        environmentProfile: request().inputs.environment_profile,
        inputVerification: {
          schemaVersion: 'talos.testing-placement-input-verification/v1',
          verifierId: 'test-provenance-verifier',
          verificationId: 'approved-repo-example',
          verificationDigest: expect.stringMatching(/^sha256:/)
        },
        executionPolicy: {
          ref: request().policy_binding.policy.ref,
          digest: request().policy_binding.policy.digest
        },
        budgets: {
          ref: request().policy_binding.budgets.ref,
          digest: request().policy_binding.budgets.digest
        },
        testingPackage: {
          packageId: request().inputs.testing_package.package_id,
          version: request().inputs.testing_package.version,
          digest: request().inputs.testing_package.digest
        },
        capability: {
          testingRuntime: 'local-qa-mvp/v1',
          taskContract: 'talos.testing-task/v1',
          maxTestingConcurrency: 1
        }
      }
    });
    expect(await repository.listQueuedTasks()).toEqual([]);

    await expect(submitTestingRun(service, 'run-1', 'user-1', { ...request(), display_goal: 'Changed' }))
      .rejects.toMatchObject({ code: 'run_identity_conflict' });
    await expect(submitTestingRun(service, 'run-2', 'user-1', request()))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(submitTestingRun(service, 'run:unsafe', 'user-1', request('unsafe-key'))).rejects.toBeDefined();
    expect(await repository.getTestingRun('run-2')).toBeUndefined();
    expect(await repository.getTestingRun('run:unsafe')).toBeUndefined();
  });

  it('reconciles an identical concurrent submit that loses a placement-policy race', async () => {
    const repository = new MemoryRepository();
    await provisionTestingPool(repository);
    const delegate = testTestingPlacementPolicy();
    let calls = 0;
    let denyEnteredResolve: (() => void) | undefined;
    let releaseDeny: (() => void) | undefined;
    const denyEntered = new Promise<void>((resolve) => { denyEnteredResolve = resolve; });
    const denied = new Promise<void>((resolve) => { releaseDeny = resolve; });
    const placementPolicy: TestingPlacementPolicy = {
      select: async (context) => {
        calls += 1;
        if (calls === 1) return delegate.select(context);
        denyEnteredResolve?.();
        await denied;
        return undefined;
      }
    };
    const service = new TestingRunService(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      placementPolicy,
      placementInputVerifier: testTestingPlacementInputVerifier()
    });

    const winner = submitTestingRun(service, 'run-policy-race', 'user-1', request('policy-race-key'));
    const loser = submitTestingRun(service, 'run-policy-race', 'user-1', request('policy-race-key'));
    await denyEntered;
    await expect(winner).resolves.toMatchObject({ created: true });
    releaseDeny?.();
    await expect(loser).resolves.toMatchObject({ created: false, acceptance: { replayed: true } });
    expect(await repository.listTestingRuns()).toHaveLength(1);
  });

  it('rejects an approved rule when its canary pool lacks the frozen machine capability', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'testing-pool', visibility: 'platform', tags: {} });
    const service = new TestingRunService(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      placementPolicy: testTestingPlacementPolicy(),
      placementInputVerifier: testTestingPlacementInputVerifier()
    });

    await expect(submitTestingRun(service, 'run-no-capability', 'user-1', request('no-capability-key')))
      .rejects.toMatchObject({ code: 'testing_placement_unavailable', status: 503 });
    expect(await repository.getTestingRun('run-no-capability')).toBeUndefined();
  });

  it('fails closed before run creation and replays an existing run without reevaluating policy', async () => {
    const repository = new MemoryRepository();
    await provisionTestingPool(repository);
    let enabled = true;
    const delegate = testTestingPlacementPolicy();
    const placementPolicy: TestingPlacementPolicy = {
      select: async (context) => enabled ? delegate.select(context) : undefined
    };
    const service = new TestingRunService(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      placementPolicy,
      placementInputVerifier: testTestingPlacementInputVerifier()
    });

    await expect(submitTestingRun(service, 'run-denied', 'user-denied', request('denied-key')))
      .rejects.toMatchObject({ code: 'testing_placement_inputs_unverified', status: 403 });
    expect(await repository.getTestingRun('run-denied')).toBeUndefined();

    expect((await submitTestingRun(service, 'run-replay-policy', 'user-1', request('replay-policy-key'))).created).toBe(true);
    enabled = false;
    await expect(submitTestingRun(service, 'run-replay-policy', 'user-1', request('replay-policy-key')))
      .resolves.toMatchObject({ created: false, acceptance: { replayed: true } });
    await expect(submitTestingRun(service, 'run-no-policy', 'user-1', request('new-policy-key')))
      .rejects.toMatchObject({ code: 'testing_placement_denied' });

    const unavailable = new TestingRunService(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      placementInputVerifier: testTestingPlacementInputVerifier()
    });
    await expect(submitTestingRun(unavailable, 'run-unavailable', 'user-1', request('unavailable-key')))
      .rejects.toMatchObject({ code: 'testing_placement_policy_unavailable', status: 503 });
  });

  it('returns stable snapshots and replay-stable opaque event pages across later state changes', async () => {
    const repository = new MemoryRepository();
    let now = Date.parse('2026-08-22T00:00:00.000Z');
    const service = await serviceFor(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      clock: () => now
    });
    await submitTestingRun(service, 'run-1', 'user-1', request());

    const snapshot = await service.get('run-1', 'user-1');
    expect(await service.get('run-1', 'user-1')).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      control_status: 'submitted',
      execution_outcome: 'not_started',
      evidence_outcome: 'not_required',
      cleanup_outcome: 'not_required'
    });
    const firstPage = await service.events('run-1', 'user-1', undefined, 1);
    expect(firstPage.events.map((event) => event.type)).toEqual(['run.submitted']);

    now += 1_000;
    const cancel = cancelRequest('run-1', 'cancel-1');
    expect(await service.cancel('run-1', 'user-1', cancel)).toMatchObject({
      accepted: true,
      replayed: false,
      control_status: 'cancel_requested',
      already_terminal: false
    });
    expect((await submitTestingRun(service, 'run-1', 'user-1', request())).acceptance).toMatchObject({
      replayed: true,
      control_status: 'submitted'
    });
    const secondPage = await service.events('run-1', 'user-1', firstPage.next_cursor, 100);
    expect(secondPage.events.map((event) => event.type)).toEqual(['run.cancel_requested']);
    expect(await service.events('run-1', 'user-1', firstPage.next_cursor, 100)).toEqual(secondPage);
    expect((await service.get('run-1', 'user-1')).snapshot_version).toBe(2);
    await expect(service.events('run-1', 'user-1', `${firstPage.next_cursor}x`, 100))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('binds cached event pages to limit and rotates a bounded cursor epoch with resync metadata', async () => {
    const repository = new MemoryRepository();
    let now = Date.parse('2026-08-22T00:00:00.000Z');
    const service = await serviceFor(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      clock: () => now
    });
    await submitTestingRun(service, 'run-limit', 'user-1', request('limit-key'));
    now += 1_000;
    await service.cancel('run-limit', 'user-1', cancelRequest('run-limit', 'cancel-limit'));

    expect((await service.events('run-limit', 'user-1', undefined, 100)).events).toHaveLength(2);
    expect((await service.events('run-limit', 'user-1', undefined, 1)).events).toHaveLength(1);

    await submitTestingRun(service, 'run-pages', 'user-1', request('pages-key'));
    let cursor = (await service.get('run-pages', 'user-1')).resume_cursor;
    for (let index = Object.keys((await repository.getTestingRun('run-pages'))?.cursorPages ?? {}).length;
      index < TESTING_CURSOR_PAGE_RETENTION;
      index += 1) {
      cursor = (await service.events('run-pages', 'user-1', cursor, 100)).next_cursor;
    }

    let replacementCursor: string | undefined;
    await expect(service.events('run-pages', 'user-1', cursor, 100)).rejects.toSatisfy((error: unknown) => {
      const candidate = error as { code?: string; status?: number; details?: Record<string, unknown> };
      replacementCursor = candidate.details?.replacement_cursor as string | undefined;
      return candidate.code === 'cursor_expired' && candidate.status === 410 &&
        candidate.details?.retryable === true && typeof replacementCursor === 'string';
    });
    const rotated = await repository.getTestingRun('run-pages');
    expect(rotated?.cursorEpoch).toBe(2);
    expect(Object.keys(rotated?.cursorPages ?? {})).toHaveLength(0);

    now += 1_000;
    await service.cancel('run-pages', 'user-1', cancelRequest('run-pages', 'cancel-after-resync'));
    if (replacementCursor === undefined) throw new Error('replacement cursor missing');
    const resynced = await service.events('run-pages', 'user-1', replacementCursor, 100);
    expect(resynced.events.map((event) => event.type)).toEqual(['run.cancel_requested']);
  });

  it('bounds the embedded cancel idempotency ledger', async () => {
    const repository = new MemoryRepository();
    const service = await serviceFor(repository, {
      cursorSecret: 'testing-cursor-secret-123456'
    });
    await submitTestingRun(service, 'run-cancel-ledger', 'user-1', request('cancel-ledger-key'));
    for (let index = 0; index < TESTING_CANCEL_RECORD_RETENTION; index += 1) {
      await service.cancel('run-cancel-ledger', 'user-1', cancelRequest('run-cancel-ledger', `cancel-${index}`));
    }
    await expect(service.cancel(
      'run-cancel-ledger',
      'user-1',
      cancelRequest('run-cancel-ledger', 'cancel-overflow')
    )).rejects.toMatchObject({ code: 'idempotency_ledger_full', status: 409 });
    expect(Object.keys((await repository.getTestingRun('run-cancel-ledger'))?.cancelRecords ?? {}))
      .toHaveLength(TESTING_CANCEL_RECORD_RETENTION);
  });

  it('binds cancel idempotency to operation, run, key, and canonical digest', async () => {
    const service = await serviceFor(new MemoryRepository(), {
      cursorSecret: 'testing-cursor-secret-123456'
    });
    await submitTestingRun(service, 'run-1', 'user-1', request());
    const cancel = cancelRequest('run-1', 'cancel-1');
    await service.cancel('run-1', 'user-1', cancel);
    expect(await service.cancel('run-1', 'user-1', cancel)).toMatchObject({ replayed: true });

    await expect(service.cancel('run-1', 'user-1', {
      ...cancelRequest('run-1', 'cancel-1', 'deadline_exceeded')
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(service.cancel('run-1', 'user-1', {
      ...cancel,
      idempotency_scope: 'talos.testing.cancel:other-run'
    })).rejects.toMatchObject({ code: 'invalid_idempotency_scope' });
    await expect(service.cancel('run-1', 'user-1', {
      ...cancel,
      canonical_request_digest: digest
    })).rejects.toMatchObject({ code: 'request_digest_mismatch' });
    await expect(service.get('run-1', 'user-2')).rejects.toMatchObject({ code: 'forbidden' });

    for (const key of ['constructor', 'toString']) {
      const requestWithPrototypeKey = cancelRequest('run-1', key);
      expect(await service.cancel('run-1', 'user-1', requestWithPrototypeKey)).toMatchObject({ replayed: false });
      expect(await service.cancel('run-1', 'user-1', requestWithPrototypeKey)).toMatchObject({ replayed: true });
    }
    await expect(service.cancel('run-1', 'user-1', cancelRequest('run-1', '__proto__'))).rejects.toBeDefined();
  });
});
