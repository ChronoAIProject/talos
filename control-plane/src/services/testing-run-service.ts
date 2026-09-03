import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalJson,
  computeTestingCancelRequestDigest,
  computeTestingRunEventDigest,
  computeTestingRunSnapshotDigest,
  computeTestingToolRequestDigest,
  digestJson,
  testingCancelAckSchema,
  testingCancelRequestSchema,
  testingCapabilitiesSchema,
  testingEventPageSchema,
  testingRunAcceptanceSchema,
  testingRunEventSchema,
  testingRunIdSchema,
  testingRunSnapshotSchema,
  testingPackageReferenceSchema,
  testingToolRequestSchema,
  testingAuthenticatedTransportContextSchema,
  type TestingCancelAck,
  type TestingCapabilities,
  type TestingEventPage,
  type TestingRunAcceptance,
  type TestingRunEvent,
  type TestingRunSnapshot,
  type TestingAuthenticatedTransportContext
} from '@talos/testing-protocol';
import { TalosError, forbidden, notFound } from '../domain/errors.js';
import {
  isTestingRunCanonicalTerminal,
  projectTestingRunAttempt,
  type TestingCursorPageRecord,
  type TestingRunRecord
} from '../domain/testing-types.js';
import type { Repository } from '../storage/repository.js';
import { newId } from '../util/id.js';
import type { TestingPlacementPolicy } from './testing-placement-policy.js';
import type { TestingPlacementInputVerifier } from './testing-placement-verifier.js';
import {
  resolveTestingExternalSchemaCapabilities,
  type TestingExternalSchemaAuthority
} from './testing-schema-authority.js';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'abandoned']);
export const TESTING_CURSOR_PAGE_RETENTION = 128;
export const TESTING_CANCEL_RECORD_RETENTION = 32;
export const TESTING_CAPABILITY_TTL_MS = 30_000;
const cursorPayloadSchema = z.object({
  version: z.literal(1),
  cursor_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  run_id: testingRunIdSchema,
  cursor_epoch: z.number().int().positive(),
  after_sequence: z.number().int().nonnegative(),
  barrier_sequence: z.number().int().nonnegative().optional(),
  snapshot_version: z.number().int().positive(),
  snapshot_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();

type CursorPayload = z.infer<typeof cursorPayloadSchema>;

const capabilityBase = {
  planning_contracts: [
    'pql.project-pack-snapshot/v1',
    'pql.test-selection/v1',
    'pql.testing-design-input-set.v1'
  ],
  tool_contracts: ['talos.testing-tool-request/v1'],
  task_contracts: ['talos.testing-task/v1'],
  execution_profiles: ['local_qa_agent_mvp'],
  runtime_capabilities: ['local-qa-mvp/v1'],
  result_contracts: [
    'testing-case-result-set.v2',
    'testing-evidence-manifest.v1',
    'qa.local-cleanup-receipt/v2'
  ],
  backends: ['browser'],
  browsers: ['chromium'],
  error_contract: {
    schema_version: 'talos.public-error/v1',
    catalog_version: 'talos.testing-error-catalog/v1'
  },
  secret_refs_supported: false,
  max_concurrency_per_machine: 1,
  limits: {
    wall_time_ms: 600_000,
    max_cases: 20,
    max_actions: 200,
    max_events: 2_000,
    max_screenshots: 20,
    max_screenshot_bytes: 5_242_880,
    max_json_evidence_bytes: 1_048_576,
    max_total_artifact_bytes: 52_428_800
  }
} as const;

export interface TestingRunServiceOptions {
  readonly cursorSecret: string;
  readonly clock?: () => number;
  readonly placementPolicy?: TestingPlacementPolicy;
  readonly placementInputVerifier?: TestingPlacementInputVerifier;
  readonly externalSchemaAuthority?: TestingExternalSchemaAuthority;
  readonly executionDependencyReadiness?: TestingExecutionDependencyReadiness;
}

export interface TestingExecutionDependencyReadiness {
  readonly persistentClaimSigningKey: boolean;
  readonly authorizationProvider: boolean;
  readonly runtimeFactVerifier: boolean;
  readonly cleanupReceiptVerifier: boolean;
}

export class TestingRunService {
  private readonly clock: () => number;

  public constructor(
    private readonly repository: Repository,
    private readonly options: TestingRunServiceOptions
  ) {
    if (options.cursorSecret.length < 16) throw new Error('testing cursor secret must be at least 16 characters');
    this.clock = options.clock ?? Date.now;
  }

  public async getCapabilities(userId: string, requesterGroups: readonly string[] = []): Promise<TestingCapabilities> {
    const observedAt = this.clock();
    const machines = await this.visibleTestingMachines(userId, requesterGroups);
    const externalSchemaCapabilities = await resolveTestingExternalSchemaCapabilities(
      this.options.externalSchemaAuthority
    );
    const reservations = await this.repository.listTestingMachineReservations();
    const reservedMachineIds = new Set(reservations.map((reservation) => reservation.machineId));
    const packages = new Map<string, TestingCapabilities['runner_packages'][number]>();
    const packagePoolIds = new Map<string, Set<string>>();
    for (const machine of machines) {
      const runner = testingPackageReferenceSchema.safeParse({
        package_id: machine.tags.runner_package_id,
        version: machine.tags.runner_package_version,
        digest: machine.tags.runner_package_digest
      });
      if (!runner.success) continue;
      const key = `${runner.data.package_id}\u0000${runner.data.version}\u0000${runner.data.digest}`;
      const current = packages.get(key);
      const testingReservations = reservedMachineIds.has(machine.id) ? 1 : 0;
      const availableCapacity = machine.online
        ? Math.max(0, machine.capacity - machine.activeLeases - testingReservations)
        : 0;
      const poolIds = new Set(packagePoolIds.get(key));
      poolIds.add(machine.poolId);
      packagePoolIds.set(key, poolIds);
      const configuredMachineCount = (current?.configured_machine_count ?? 0) + 1;
      const onlineMachineCount = (current?.online_machine_count ?? 0) + (machine.online ? 1 : 0);
      const totalCapacity = (current?.available_capacity ?? 0) + availableCapacity;
      packages.set(key, {
        ...runner.data,
        availability: configuredCapabilityAvailability(onlineMachineCount, totalCapacity),
        visible_pool_count: boundedCapabilityCount(poolIds.size),
        configured_machine_count: boundedCapabilityCount(configuredMachineCount),
        online_machine_count: boundedCapabilityCount(onlineMachineCount),
        available_capacity: boundedCapabilityCount(totalCapacity)
      });
    }
    const allRunnerPackages = [...packages.values()]
      .sort((left, right) => `${left.package_id}\u0000${left.version}\u0000${left.digest}`
        .localeCompare(`${right.package_id}\u0000${right.version}\u0000${right.digest}`));
    const runnerPackages = allRunnerPackages.slice(0, 64);
    const visiblePoolCount = new Set(machines.map((machine) => machine.poolId)).size;
    const onlineMachineCount = machines.filter((machine) => machine.online).length;
    const availableCapacity = machines.reduce(
      (total, machine) => total + (machine.online
        ? Math.max(0, machine.capacity - machine.activeLeases - (reservedMachineIds.has(machine.id) ? 1 : 0))
        : 0),
      0
    );
    return testingCapabilitiesSchema.parse({
      schema_version: 'talos.testing-capabilities/v1',
      operations: ['get_capabilities', 'submit', 'get', 'events', 'cancel'],
      observed_at: new Date(observedAt).toISOString(),
      valid_until: new Date(observedAt + TESTING_CAPABILITY_TTL_MS).toISOString(),
      scope: 'resolved_identity_visible_pools',
      ...capabilityBase,
      external_schema_capabilities: externalSchemaCapabilities,
      admission_availability: this.admissionAvailability(externalSchemaCapabilities),
      backend_availability: {
        backend: 'browser',
        browser: 'chromium',
        availability: capabilityAvailability(machines.length, onlineMachineCount, availableCapacity),
        visible_pool_count: boundedCapabilityCount(visiblePoolCount),
        configured_machine_count: boundedCapabilityCount(machines.length),
        online_machine_count: boundedCapabilityCount(onlineMachineCount),
        available_capacity: boundedCapabilityCount(availableCapacity)
      },
      runner_packages: runnerPackages,
      runner_packages_total_count: boundedCapabilityCount(allRunnerPackages.length),
      runner_packages_truncated: allRunnerPackages.length > runnerPackages.length
    });
  }

  private async visibleTestingMachines(
    userId: string,
    requesterGroups: readonly string[]
  ): Promise<readonly Awaited<ReturnType<Repository['listMachines']>>[number][]> {
    const machines = await this.repository.listMachines();
    const pools = new Map(await Promise.all([...new Set(machines.map((machine) => machine.poolId))].map(async (poolId) =>
      [poolId, await this.repository.getPool(poolId)] as const)));
    return machines.filter((machine) => {
      const pool = pools.get(machine.poolId);
      return pool !== undefined && poolVisible(pool, userId, requesterGroups) &&
        machine.tags.testing_runtime === 'local-qa-mvp/v1' &&
        machine.tags.testing_task_contract === 'talos.testing-task/v1' &&
        machine.tags.testing_backend === 'browser' &&
        machine.tags.browser === 'chromium' &&
        machine.tags.os === 'darwin' &&
        machine.tags.arch === 'arm64' &&
        machine.tags.headed_display === true &&
        machine.capacity === 1 &&
        testingPackageReferenceSchema.safeParse({
          package_id: machine.tags.runner_package_id,
          version: machine.tags.runner_package_version,
          digest: machine.tags.runner_package_digest
        }).success;
    });
  }

  public async submit(
    runIdInput: string,
    userId: string,
    input: unknown,
    authenticatedTransportInput: unknown,
    requesterGroups: readonly string[] = []
  ): Promise<{ acceptance: TestingRunAcceptance; created: boolean }> {
    const runId = testingRunIdSchema.parse(runIdInput);
    const request = testingToolRequestSchema.parse(input);
    const requestDigest = computeTestingToolRequestDigest(runId, request);
    const authenticatedTransport = this.assertAuthenticatedTransport(
      runId,
      userId,
      request.client_correlation_id,
      requestDigest,
      authenticatedTransportInput
    );
    const replay = await this.resolveExistingSubmit(
      runId,
      userId,
      request.idempotency_key,
      requestDigest
    );
    if (replay !== undefined) {
      return {
        acceptance: testingRunAcceptanceSchema.parse({ ...replay.acceptance, replayed: true }),
        created: false
      };
    }
    const now = new Date(this.clock()).toISOString();
    let placement: TestingRunRecord['placement'];
    try {
      this.assertExecutionDependenciesReady();
      await this.assertExternalSchemaAdmissionReady();
      placement = await this.selectPlacement(userId, requesterGroups, request, now);
    } catch (error) {
      const racedReplay = await this.resolveExistingSubmit(
        runId,
        userId,
        request.idempotency_key,
        requestDigest
      );
      if (racedReplay !== undefined) {
        return {
          acceptance: testingRunAcceptanceSchema.parse({ ...racedReplay.acceptance, replayed: true }),
          created: false
        };
      }
      throw error;
    }
    const event = makeEvent(1, 'run.submitted', now, {
      request_id: request.request_id,
      client_correlation_id: request.client_correlation_id,
      request_digest: requestDigest,
      authenticated_transport: authenticatedTransport
    });
    const acceptance = testingRunAcceptanceSchema.parse({
      schema_version: 'talos.testing-run-acceptance/v1',
      run_id: runId,
      request_id: request.request_id,
      client_correlation_id: request.client_correlation_id,
      accepted: true,
      replayed: false,
      control_status: 'submitted',
      request_digest: requestDigest,
      authenticated_transport: authenticatedTransport,
      created_at: now
    });
    const taskId = newId('testing-task');
    const run: TestingRunRecord = {
      id: runId,
      userId,
      idempotencyKey: request.idempotency_key,
      requestDigest,
      request,
      authenticatedTransport,
      requesterGroups: [...requesterGroups],
      placement,
      acceptance,
      deadlineAt: new Date(Date.parse(now) + request.policy.budgets.wall_time_ms).toISOString(),
      recordVersion: 1,
      snapshotVersion: 1,
      cursorEpoch: 1,
      controlStatus: 'submitted',
      executionOutcome: 'not_started',
      evidenceOutcome: 'not_required',
      uploadOutcome: 'not_required',
      cleanupOutcome: 'not_required',
      progress: {
        phase: 'submitted',
        completed_cases: 0,
        total_cases: 0,
        last_event_sequence: event.sequence
      },
      events: [event],
      cursorPages: {},
      cancelRecords: {},
      task: {
        id: taskId,
        status: 'submitted',
        nextGeneration: 1,
        createdAt: now,
        updatedAt: now
      },
      attempts: [],
      createdAt: now,
      updatedAt: now
    };

    if (await this.repository.createTestingRun(run)) {
      return { acceptance, created: true };
    }
    const existing = await this.resolveSubmitConflict(run);
    return {
      acceptance: testingRunAcceptanceSchema.parse({ ...existing.acceptance, replayed: true }),
      created: false
    };
  }

  public async get(runId: string, userId: string): Promise<TestingRunSnapshot> {
    return this.snapshot(await this.authorizedRun(testingRunIdSchema.parse(runId), userId));
  }

  public async events(
    runIdInput: string,
    userId: string,
    cursorToken: string | undefined,
    limit: number
  ): Promise<TestingEventPage> {
    const runId = testingRunIdSchema.parse(runIdInput);
    for (let retries = 0; retries < 20; retries += 1) {
      const run = await this.authorizedRun(runId, userId);
      const snapshot = this.snapshot(run);
      const cursor = cursorToken === undefined
        ? this.cursorPayload(run, snapshot, 0, undefined, 'initial')
        : this.verifyCursor(cursorToken);
      if (cursor.run_id !== run.id) throw new TalosError('invalid_cursor', 'cursor belongs to another run', 400);
      if (cursor.cursor_epoch !== run.cursorEpoch) throw this.cursorExpired(run, snapshot);
      const pageKey = digestJson({ cursor_id: cursor.cursor_id, limit });
      const stored = run.cursorPages[pageKey];
      if (stored !== undefined) return this.eventPage(run.id, stored);

      const firstSequence = run.events[0]?.sequence ?? run.progress.last_event_sequence + 1;
      if (cursor.after_sequence < firstSequence - 1) throw this.cursorExpired(run, snapshot);
      const upperSequence = cursor.barrier_sequence ?? run.progress.last_event_sequence;
      if (cursor.after_sequence > upperSequence) throw new TalosError('invalid_cursor', 'cursor sequence exceeds its barrier', 400);
      if (Object.keys(run.cursorPages).length >= TESTING_CURSOR_PAGE_RETENTION) {
        const rotated: TestingRunRecord = {
          ...run,
          recordVersion: run.recordVersion + 1,
          snapshotVersion: run.snapshotVersion + 1,
          cursorEpoch: run.cursorEpoch + 1,
          cursorPages: {},
          updatedAt: new Date(this.clock()).toISOString()
        };
        if (await this.repository.replaceTestingRun(rotated, run.recordVersion)) {
          throw this.cursorExpired(rotated, this.snapshot(rotated));
        }
        continue;
      }
      const candidates = run.events.filter((event) =>
        event.sequence > cursor.after_sequence && event.sequence <= upperSequence);
      const pageEvents = candidates.slice(0, limit);
      const hasMore = candidates.length > pageEvents.length;
      const afterSequence = pageEvents.at(-1)?.sequence ?? cursor.after_sequence;
      const nextPayload = this.cursorPayload(
        run,
        snapshot,
        afterSequence,
        hasMore ? upperSequence : undefined,
        cursor.cursor_id
      );
      const page: TestingCursorPageRecord = {
        events: pageEvents,
        nextCursor: this.signCursor(nextPayload),
        hasMore
      };
      const updated: TestingRunRecord = {
        ...run,
        recordVersion: run.recordVersion + 1,
        cursorPages: { ...run.cursorPages, [pageKey]: page }
      };
      if (await this.repository.replaceTestingRun(updated, run.recordVersion)) return this.eventPage(run.id, page);
    }
    throw new TalosError('concurrent_update', 'testing run changed too frequently', 409);
  }

  public async cancel(runIdInput: string, userId: string, input: unknown): Promise<TestingCancelAck> {
    const runId = testingRunIdSchema.parse(runIdInput);
    const request = testingCancelRequestSchema.parse(input);
    const expectedScope = `talos.testing.cancel:${runId}`;
    if (request.idempotency_scope !== expectedScope) {
      throw new TalosError('invalid_idempotency_scope', 'cancel idempotency scope does not match path run_id', 400);
    }
    const { canonical_request_digest: suppliedDigest, ...unsignedRequest } = request;
    const requestDigest = computeTestingCancelRequestDigest(runId, unsignedRequest);
    if (suppliedDigest !== requestDigest) {
      throw new TalosError('request_digest_mismatch', 'canonical_request_digest does not match cancel request', 400);
    }

    for (let retries = 0; retries < 20; retries += 1) {
      const run = await this.authorizedRun(runId, userId);
      const previous = Object.hasOwn(run.cancelRecords, request.idempotency_key)
        ? run.cancelRecords[request.idempotency_key]
        : undefined;
      if (previous !== undefined) {
        if (previous.requestDigest !== requestDigest) {
          throw new TalosError('idempotency_conflict', 'cancel idempotency key was used with another digest', 409);
        }
        return testingCancelAckSchema.parse({ ...previous.acknowledgement, replayed: true });
      }
      if (Object.keys(run.cancelRecords).length >= TESTING_CANCEL_RECORD_RETENTION) {
        throw new TalosError('idempotency_ledger_full', 'testing cancel idempotency ledger is full', 409, {
          retryable: false
        });
      }

      const controlClosed = terminalStatuses.has(run.controlStatus);
      const alreadyTerminal = isTestingRunCanonicalTerminal(run);
      const status = controlClosed ? run.controlStatus : 'cancel_requested';
      const stateChanged = status !== run.controlStatus;
      const now = new Date(this.clock()).toISOString();
      const nextEvent = stateChanged
        ? makeEvent(run.progress.last_event_sequence + 1, 'run.cancel_requested', now, { reason_code: request.reason })
        : undefined;
      const acknowledgement = testingCancelAckSchema.parse({
        schema_version: 'talos.testing-cancel-ack/v1',
        run_id: run.id,
        accepted: true,
        replayed: false,
        already_terminal: alreadyTerminal,
        control_status: status,
        canonical_request_digest: requestDigest
      });
      const updated: TestingRunRecord = {
        ...run,
        recordVersion: run.recordVersion + 1,
        snapshotVersion: stateChanged ? run.snapshotVersion + 1 : run.snapshotVersion,
        controlStatus: status,
        task: stateChanged
          ? { ...run.task, status: 'cancel_requested', updatedAt: now }
          : run.task,
        progress: nextEvent === undefined
          ? run.progress
          : { ...run.progress, phase: 'cancel_requested', last_event_sequence: nextEvent.sequence },
        events: nextEvent === undefined ? run.events : appendBoundedEvent(run, nextEvent),
        cancelRecords: {
          ...run.cancelRecords,
          [request.idempotency_key]: { requestDigest, acknowledgement }
        },
        updatedAt: stateChanged ? now : run.updatedAt
      };
      if (await this.repository.replaceTestingRun(updated, run.recordVersion)) return acknowledgement;
    }
    throw new TalosError('concurrent_update', 'testing run changed too frequently', 409);
  }

  private async resolveSubmitConflict(candidate: TestingRunRecord): Promise<TestingRunRecord> {
    const byRun = await this.repository.getTestingRun(candidate.id);
    if (byRun !== undefined) {
      if (
        byRun.userId !== candidate.userId ||
        byRun.requestDigest !== candidate.requestDigest ||
        byRun.idempotencyKey !== candidate.idempotencyKey
      ) {
        throw new TalosError('run_identity_conflict', 'run_id is bound to another testing request', 409);
      }
      return byRun;
    }
    const byKey = await this.repository.getTestingRunByIdempotencyKey(candidate.userId, candidate.idempotencyKey);
    if (byKey !== undefined) {
      throw new TalosError('idempotency_conflict', 'idempotency key is bound to another run or request', 409);
    }
    throw new TalosError('concurrent_update', 'testing run creation could not be reconciled', 409);
  }

  private async resolveExistingSubmit(
    runId: string,
    userId: string,
    idempotencyKey: string,
    requestDigest: string
  ): Promise<TestingRunRecord | undefined> {
    const byRun = await this.repository.getTestingRun(runId);
    if (byRun !== undefined) {
      if (
        byRun.userId !== userId ||
        byRun.requestDigest !== requestDigest ||
        byRun.idempotencyKey !== idempotencyKey
      ) {
        throw new TalosError('run_identity_conflict', 'run_id is bound to another testing request', 409);
      }
      return byRun;
    }
    const byKey = await this.repository.getTestingRunByIdempotencyKey(userId, idempotencyKey);
    if (byKey !== undefined) {
      throw new TalosError('idempotency_conflict', 'idempotency key is bound to another run or request', 409);
    }
    return undefined;
  }

  private async selectPlacement(
    userId: string,
    requesterGroups: readonly string[],
    request: ReturnType<typeof testingToolRequestSchema.parse>,
    selectedAt: string
  ): Promise<TestingRunRecord['placement']> {
    const verifier = this.options.placementInputVerifier;
    if (verifier === undefined) {
      throw new TalosError('testing_placement_verifier_unavailable', 'testing placement input verifier is unavailable', 503);
    }
    const verifiedInputs = await verifier.verify({
      callerUserId: userId,
      callerGroups: requesterGroups,
      inputs: request.inputs
    });
    if (verifiedInputs === undefined) {
      throw new TalosError('testing_placement_inputs_unverified', 'testing provenance inputs are not approved for placement', 403);
    }
    const policy = this.options.placementPolicy;
    if (policy === undefined) {
      throw new TalosError('testing_placement_policy_unavailable', 'testing placement policy is unavailable', 503);
    }
    const decision = await policy.select({
      callerUserId: userId,
      callerGroups: requesterGroups,
      verifiedInputs,
      executionPolicy: request.policy_binding.policy,
      budgets: request.policy_binding.budgets,
      testingPackage: request.inputs.testing_package
    });
    if (decision === undefined) {
      throw new TalosError('testing_placement_denied', 'testing request is not allowlisted for canary placement', 403);
    }
    const pool = await this.repository.getPool(decision.poolId);
    if (pool === undefined) {
      throw new TalosError('testing_placement_unavailable', 'testing canary pool is unavailable', 503);
    }
    if (!poolVisible(pool, userId, requesterGroups)) {
      throw new TalosError('testing_placement_denied', 'testing canary pool is not visible to this identity', 403);
    }
    const machines = await this.repository.listMachines(pool.id);
    if (!machines.some((machine) => machineMatchesPlacement(machine, decision))) {
      throw new TalosError('testing_placement_unavailable', 'testing canary pool does not advertise the approved capability contract', 503);
    }
    return { ...decision, selectedAt };
  }

  private admissionAvailability(
    externalSchemaCapabilities: readonly TestingCapabilities['external_schema_capabilities'][number][]
  ): TestingCapabilities['admission_availability'] {
    const executionDependency = this.unavailableExecutionDependency();
    if (executionDependency !== undefined) {
      return { status: 'unavailable', reason_code: executionDependency.code };
    }
    if (externalSchemaCapabilities.some((capability) => capability.status !== 'available')) {
      return { status: 'unavailable', reason_code: 'external_schema_authority_unavailable' };
    }
    if (this.options.placementInputVerifier === undefined) {
      return { status: 'unavailable', reason_code: 'testing_placement_verifier_unavailable' };
    }
    if (this.options.placementPolicy === undefined) {
      return { status: 'unavailable', reason_code: 'testing_placement_policy_unavailable' };
    }
    return { status: 'available', reason_code: null };
  }

  private assertExecutionDependenciesReady(): void {
    const unavailable = this.unavailableExecutionDependency();
    if (unavailable !== undefined) throw new TalosError(unavailable.code, unavailable.message, 503);
  }

  private unavailableExecutionDependency(): { code: string; message: string } | undefined {
    const readiness = this.options.executionDependencyReadiness;
    if (readiness?.persistentClaimSigningKey !== true) {
      return {
        code: 'testing_claim_signing_key_unavailable',
        message: 'persistent testing claim signing key is unavailable'
      };
    }
    if (readiness.authorizationProvider !== true) {
      return {
        code: 'testing_authorization_unavailable',
        message: 'testing authorization provider is unavailable'
      };
    }
    if (readiness.runtimeFactVerifier !== true) {
      return {
        code: 'testing_fact_verifier_unavailable',
        message: 'testing Runtime fact verifier is unavailable'
      };
    }
    if (readiness.cleanupReceiptVerifier !== true) {
      return {
        code: 'cleanup_verifier_unavailable',
        message: 'cleanup receipt verifier is unavailable'
      };
    }
    return undefined;
  }

  private async assertExternalSchemaAdmissionReady(): Promise<void> {
    const capabilities = await resolveTestingExternalSchemaCapabilities(this.options.externalSchemaAuthority);
    if (capabilities.some((capability) => capability.status !== 'available')) {
      throw new TalosError(
        'external_schema_authority_unavailable',
        'upstream schema authority is unavailable for testing admission',
        503
      );
    }
  }

  private assertAuthenticatedTransport(
    runId: string,
    userId: string,
    clientCorrelationId: string,
    requestDigest: string,
    input: unknown
  ): TestingAuthenticatedTransportContext {
    const context = testingAuthenticatedTransportContextSchema.parse(input);
    if (context.subject !== userId) {
      throw new TalosError('nyxid_subject_mismatch', 'NyxID transport subject does not match the resolved caller', 401);
    }
    if (context.route.run_id !== runId) {
      throw new TalosError('nyxid_route_mismatch', 'NyxID transport route is bound to another run', 401);
    }
    if (context.authorization.run_id !== runId) {
      throw new TalosError('nyxid_authorization_mismatch', 'NyxID authorization is bound to another run', 401);
    }
    if (Date.parse(context.authorization.valid_until) <= this.clock()) {
      throw new TalosError('nyxid_authorization_expired', 'NyxID authorization is expired', 401);
    }
    if (context.verified_client_correlation_id !== clientCorrelationId) {
      throw new TalosError(
        'nyxid_client_correlation_mismatch',
        'NyxID transport context is bound to another client correlation',
        401
      );
    }
    if (context.verified_request_digest !== requestDigest) {
      throw new TalosError('nyxid_request_digest_mismatch', 'NyxID transport context is bound to another request', 401);
    }
    return context;
  }

  private snapshot(run: TestingRunRecord): TestingRunSnapshot {
    const core = {
      schema_version: 'talos.testing-run-snapshot/v1' as const,
      run_id: run.id,
      request_id: run.request.request_id,
      client_correlation_id: run.request.client_correlation_id,
      authenticated_transport: run.authenticatedTransport,
      inputs: run.request.inputs,
      snapshot_version: run.snapshotVersion,
      snapshot_ref: `talos://testing/runs/${run.id}/snapshots/${run.snapshotVersion}`,
      control_status: run.controlStatus,
      execution_outcome: run.executionOutcome,
      evidence_outcome: run.evidenceOutcome,
      upload_outcome: run.uploadOutcome,
      cleanup_outcome: run.cleanupOutcome,
      terminal: isTestingRunCanonicalTerminal(run),
      terminal_reason: run.terminalReason ?? null,
      blocking: run.blocking ?? null,
      attempt: projectTestingRunAttempt(run) ?? null,
      progress: run.progress,
      summary: run.summary ?? null,
      results: run.results ?? null,
      safe_error: run.safeError ?? null,
      created_at: run.createdAt,
      updated_at: run.updatedAt
    };
    const snapshotDigest = computeTestingRunSnapshotDigest(core);
    const cursor = this.cursorPayload(run, {
      snapshot_version: run.snapshotVersion,
      snapshot_digest: snapshotDigest
    }, run.progress.last_event_sequence, undefined, 'resume');
    return testingRunSnapshotSchema.parse({
      ...core,
      snapshot_digest: snapshotDigest,
      resume_cursor: this.signCursor(cursor)
    });
  }

  private cursorPayload(
    run: TestingRunRecord,
    snapshot: Pick<TestingRunSnapshot, 'snapshot_version' | 'snapshot_digest'>,
    afterSequence: number,
    barrierSequence: number | undefined,
    parent: string
  ): CursorPayload {
    const identity = {
      run_id: run.id,
      cursor_epoch: run.cursorEpoch,
      snapshot_version: snapshot.snapshot_version,
      snapshot_digest: snapshot.snapshot_digest,
      after_sequence: afterSequence,
      ...(barrierSequence === undefined ? {} : { barrier_sequence: barrierSequence }),
      parent
    };
    return cursorPayloadSchema.parse({
      version: 1,
      cursor_id: digestJson(identity),
      run_id: run.id,
      cursor_epoch: run.cursorEpoch,
      after_sequence: afterSequence,
      ...(barrierSequence === undefined ? {} : { barrier_sequence: barrierSequence }),
      snapshot_version: snapshot.snapshot_version,
      snapshot_digest: snapshot.snapshot_digest
    });
  }

  private signCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
    const signature = createHmac('sha256', this.options.cursorSecret).update(encoded).digest('base64url');
    return `tc1.${encoded}.${signature}`;
  }

  private verifyCursor(token: string): CursorPayload {
    const [prefix, encoded, suppliedSignature, extra] = token.split('.');
    if (prefix !== 'tc1' || encoded === undefined || suppliedSignature === undefined || extra !== undefined) {
      throw new TalosError('invalid_cursor', 'event cursor is malformed', 400);
    }
    const expectedSignature = createHmac('sha256', this.options.cursorSecret).update(encoded).digest();
    let actualSignature: Buffer;
    try {
      actualSignature = Buffer.from(suppliedSignature, 'base64url');
    } catch {
      throw new TalosError('invalid_cursor', 'event cursor signature is malformed', 400);
    }
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new TalosError('invalid_cursor', 'event cursor signature is invalid', 400);
    }
    try {
      return cursorPayloadSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    } catch {
      throw new TalosError('invalid_cursor', 'event cursor payload is invalid', 400);
    }
  }

  private eventPage(runId: string, page: TestingCursorPageRecord): TestingEventPage {
    return testingEventPageSchema.parse({
      schema_version: 'talos.testing-event-page/v1',
      run_id: runId,
      events: page.events,
      next_cursor: page.nextCursor,
      has_more: page.hasMore
    });
  }

  private cursorExpired(run: TestingRunRecord, snapshot: TestingRunSnapshot): TalosError {
    return new TalosError('cursor_expired', 'event cursor is outside the retention window', 410, {
      retryable: true,
      replacement_cursor: snapshot.resume_cursor,
      snapshot_ref: snapshot.snapshot_ref,
      snapshot_version: snapshot.snapshot_version,
      snapshot_digest: snapshot.snapshot_digest
    });
  }

  private async authorizedRun(runId: string, userId: string): Promise<TestingRunRecord> {
    const run = await this.repository.getTestingRun(runId);
    if (run === undefined) throw notFound('testing run not found');
    if (run.userId !== userId) throw forbidden('testing run belongs to another identity');
    return run;
  }
}

const makeEvent = (
  sequence: number,
  type: TestingRunEvent['type'],
  time: string,
  data: TestingRunEvent['data']
): TestingRunEvent => {
  const core = { sequence, type, time, data };
  return testingRunEventSchema.parse({ ...core, event_digest: computeTestingRunEventDigest(core) });
};

const appendBoundedEvent = (run: TestingRunRecord, event: TestingRunEvent): readonly TestingRunEvent[] => {
  const events = [...run.events, event];
  return events.slice(-run.request.policy.budgets.max_events);
};

const poolVisible = (
  pool: NonNullable<Awaited<ReturnType<Repository['getPool']>>>,
  userId: string,
  groups: readonly string[]
): boolean => {
  if (pool.visibility === 'platform' || pool.ownerUserId === userId) return true;
  if (pool.visibility === 'private') return false;
  return (pool.sharedWithGroups ?? []).some((group) => groups.includes(group));
};

const boundedCapabilityCount = (value: number): number => Math.min(1_000_000, value);

const capabilityAvailability = (
  configuredMachineCount: number,
  onlineMachineCount: number,
  availableCapacity: number
): 'available' | 'busy' | 'offline' | 'unavailable' => {
  if (availableCapacity > 0) return 'available';
  if (onlineMachineCount > 0) return 'busy';
  if (configuredMachineCount > 0) return 'offline';
  return 'unavailable';
};

const configuredCapabilityAvailability = (
  onlineMachineCount: number,
  availableCapacity: number
): 'available' | 'busy' | 'offline' => {
  if (availableCapacity > 0) return 'available';
  if (onlineMachineCount > 0) return 'busy';
  return 'offline';
};

const machineMatchesPlacement = (
  machine: Awaited<ReturnType<Repository['listMachines']>>[number],
  placement: Omit<TestingRunRecord['placement'], 'selectedAt'>
): boolean => machine.poolId === placement.poolId &&
  machine.capacity === placement.capability.maxTestingConcurrency &&
  machine.tags.testing_runtime === placement.capability.testingRuntime &&
  machine.tags.testing_task_contract === placement.capability.taskContract &&
  machine.tags.testing_backend === placement.capability.backend &&
  machine.tags.browser === placement.capability.browser &&
  machine.tags.os === placement.capability.os &&
  machine.tags.arch === placement.capability.arch &&
  machine.tags.headed_display === placement.capability.headedDisplay &&
  machine.tags.runner_package_id === placement.testingPackage.packageId &&
  machine.tags.runner_package_version === placement.testingPackage.version &&
  machine.tags.runner_package_digest === placement.testingPackage.digest;
