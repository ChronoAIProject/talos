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
  testingToolRequestSchema,
  type TestingCancelAck,
  type TestingCapabilities,
  type TestingEventPage,
  type TestingRunAcceptance,
  type TestingRunEvent,
  type TestingRunSnapshot
} from '@talos/testing-protocol';
import { TalosError, forbidden, notFound } from '../domain/errors.js';
import type { TestingCursorPageRecord, TestingRunRecord } from '../domain/testing-types.js';
import type { Repository } from '../storage/repository.js';
import { newId } from '../util/id.js';
import type { TestingPlacementPolicy } from './testing-placement-policy.js';
import type { TestingPlacementInputVerifier } from './testing-placement-verifier.js';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'abandoned']);
export const TESTING_CURSOR_PAGE_RETENTION = 128;
export const TESTING_CANCEL_RECORD_RETENTION = 32;
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

const capabilities: TestingCapabilities = testingCapabilitiesSchema.parse({
  schema_version: 'talos.testing-capabilities/v1',
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
});

export interface TestingRunServiceOptions {
  readonly cursorSecret: string;
  readonly clock?: () => number;
  readonly placementPolicy?: TestingPlacementPolicy;
  readonly placementInputVerifier?: TestingPlacementInputVerifier;
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

  public getCapabilities(): TestingCapabilities {
    return capabilities;
  }

  public async submit(
    runIdInput: string,
    userId: string,
    input: unknown,
    requesterGroups: readonly string[] = []
  ): Promise<{ acceptance: TestingRunAcceptance; created: boolean }> {
    const runId = testingRunIdSchema.parse(runIdInput);
    const request = testingToolRequestSchema.parse(input);
    const requestDigest = computeTestingToolRequestDigest(runId, request);
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
    const event = makeEvent(1, 'run.submitted', now, { request_digest: requestDigest });
    const acceptance = testingRunAcceptanceSchema.parse({
      schema_version: 'talos.testing-run-acceptance/v1',
      run_id: runId,
      accepted: true,
      replayed: false,
      control_status: 'submitted',
      request_digest: requestDigest,
      created_at: now
    });
    const taskId = newId('testing-task');
    const run: TestingRunRecord = {
      id: runId,
      userId,
      idempotencyKey: request.idempotency_key,
      requestDigest,
      request,
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

      const alreadyTerminal = terminalStatuses.has(run.controlStatus);
      const status = alreadyTerminal ? run.controlStatus : 'cancel_requested';
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

  private snapshot(run: TestingRunRecord): TestingRunSnapshot {
    const core = {
      schema_version: 'talos.testing-run-snapshot/v1' as const,
      run_id: run.id,
      snapshot_version: run.snapshotVersion,
      snapshot_ref: `talos://testing/runs/${run.id}/snapshots/${run.snapshotVersion}`,
      control_status: run.controlStatus,
      execution_outcome: run.executionOutcome,
      evidence_outcome: run.evidenceOutcome,
      upload_outcome: run.uploadOutcome,
      cleanup_outcome: run.cleanupOutcome,
      attempt: run.attempt ?? null,
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
