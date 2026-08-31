import { z } from 'zod';
import {
  digestJson,
  identifierSchema,
  immutableReferenceSchema,
  jsonValueSchema,
  sha256DigestSchema,
  testingPackageReferenceSchema,
  testingRunIdSchema
} from './contracts.js';
import {
  testingControlStatusSchema,
  testingCurrentClaimEnvelopeSchema,
  testingEvidenceOutcomeSchema,
  testingLeaseClaimReferenceSchema,
  testingLocalRequestAuthorizationReferenceSchema,
  testingNoLocalAcceptanceFactSchema,
  testingReconcileTaskSchema,
  testingRunProgressSchema,
  testingRunSummarySchema,
  testingSafeErrorSchema,
  testingTaskSchema,
  testingTerminalRefsSchema,
  testingUploadOutcomeSchema
} from './testing-tool.js';

const timestampSchema = z.string().datetime({ offset: true });
const requestNonceSchema = z.string().min(16).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const localQaReferenceSchema = z.string().min(1).max(2048)
  .regex(/^local-qa:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/);
const idempotencyKeySchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const fenceTokenSchema = z.string().min(16).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const localQAExecutionOutcomeSchema = z.enum([
  'not_started', 'executing', 'passed', 'failed', 'blocked', 'error', 'timed_out', 'all_skipped',
  'cancelled', 'lost_or_inconclusive'
]);
const localQACleanupOutcomeSchema = z.enum([
  'not_required', 'pending', 'complete', 'residual_retryable', 'residual_blocking'
]);

export const testingRuntimeOperationSchema = z.enum(['start', 'cancel', 'reconcile']);

export const testingRuntimeAttemptSchema = z.object({
  schema_version: z.literal('talos.testing-runtime-attempt/v1'),
  operation: z.enum(['start', 'reconcile']),
  run_id: testingRunIdSchema,
  task_id: identifierSchema,
  attempt_id: identifierSchema,
  machine_id: identifierSchema,
  worker_id: identifierSchema,
  generation: z.number().int().positive(),
  lease_id: identifierSchema,
  fence_token: fenceTokenSchema,
  admission_nonce: requestNonceSchema,
  task_payload_digest: sha256DigestSchema,
  lease_claim: testingLeaseClaimReferenceSchema,
  deadline: timestampSchema
}).strict();

export const testingRuntimeExecutionBindingSchema = z.object({
  schema_version: z.literal('talos.testing-runtime-execution-binding/v1'),
  run_id: testingRunIdSchema,
  task_id: identifierSchema,
  attempt_id: identifierSchema,
  machine_id: identifierSchema,
  generation: z.number().int().positive(),
  fence_token: fenceTokenSchema
}).strict();

export const testingAuthorizationResolutionRequestSchema = z.object({
  schema_version: z.literal('talos.testing-authorization-resolution-request/v1'),
  operation: testingRuntimeOperationSchema,
  authorization_reference: testingLocalRequestAuthorizationReferenceSchema.optional(),
  attempt: testingRuntimeAttemptSchema,
  current_claim_digest: sha256DigestSchema,
  http_method: z.enum(['PUT', 'POST']),
  canonical_path: z.string().min(1).max(2048).regex(/^\/v1\/runs\/[A-Za-z0-9._-]+(?::(?:cancel|reconcile-terminal))?$/),
  body_digest: sha256DigestSchema
}).strict().superRefine((value, context) => {
  if (value.operation === 'start' && value.authorization_reference === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'start requires the claim authorization reference', path: ['authorization_reference'] });
  }
  if ((value.operation === 'start') !== (value.http_method === 'PUT')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'start uses PUT and control operations use POST', path: ['http_method'] });
  }
  if ((value.operation === 'start' && value.attempt.operation !== 'start') ||
      (value.operation === 'reconcile' && value.attempt.operation !== 'reconcile')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'authorization operation is incompatible with the claim operation', path: ['attempt', 'operation'] });
  }
});

export const testingAuthorizationResolutionSchema = z.object({
  schema_version: z.literal('talos.testing-authorization-resolution/v1'),
  operation: testingRuntimeOperationSchema,
  authorization_reference: testingLocalRequestAuthorizationReferenceSchema,
  attempt: testingRuntimeAttemptSchema,
  current_claim_digest: sha256DigestSchema,
  http_method: z.enum(['PUT', 'POST']),
  canonical_path: z.string().min(1).max(2048),
  body_digest: sha256DigestSchema,
  authorization: jsonValueSchema,
  signature_verified: z.literal(true),
  signer_key_id: identifierSchema,
  verified_at: timestampSchema
}).strict().superRefine((value, context) => {
  if (digestJson(value.authorization) !== value.authorization_reference.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'authorization digest does not match the signed envelope', path: ['authorization'] });
  }
  if (value.authorization_reference.expires_at !== value.attempt.deadline &&
      Date.parse(value.authorization_reference.expires_at) > Date.parse(value.attempt.deadline)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'authorization cannot outlive the attempt deadline', path: ['authorization_reference', 'expires_at'] });
  }
});

export const localQARuntimeCapabilitiesSchema = z.object({
  schema_version: z.literal('local-qa-runtime-capabilities/v1'),
  adapter_contracts: z.array(z.literal('talos.local-qa-runtime-adapter/v1')).min(1).max(4),
  runtime_capabilities: z.array(z.literal('local-qa-mvp/v1')).min(1).max(4),
  execution_profiles: z.array(z.literal('local_qa_agent_mvp')).min(1).max(4),
  runner_packages: z.array(testingPackageReferenceSchema).max(64),
  max_concurrency: z.literal(1),
  limits: z.object({
    max_events_per_page: z.number().int().positive().max(100),
    max_snapshot_bytes: z.number().int().positive().max(1_048_576),
    max_event_page_bytes: z.number().int().positive().max(1_048_576)
  }).strict()
}).strict();

const localQARuntimeSnapshotCoreSchema = z.object({
  schema_version: z.literal('local-qa-runtime-snapshot/v1'),
  snapshot_ref: localQaReferenceSchema,
  snapshot_version: z.number().int().positive(),
  run_id: testingRunIdSchema,
  attempt: testingRuntimeExecutionBindingSchema,
  state: z.enum([
    'accepted', 'preparing', 'ready', 'executing', 'staging_evidence',
    'cleaning_up_execution', 'uploading', 'finalizing_local', 'terminal'
  ]),
  event_sequence: z.number().int().nonnegative(),
  progress: testingRunProgressSchema,
  execution_outcome: localQAExecutionOutcomeSchema.optional(),
  evidence_outcome: testingEvidenceOutcomeSchema.optional(),
  upload_outcome: testingUploadOutcomeSchema.optional(),
  cleanup_outcome: localQACleanupOutcomeSchema.optional(),
  summary: testingRunSummarySchema.optional(),
  results: testingTerminalRefsSchema.optional(),
  safe_error: testingSafeErrorSchema.optional(),
  updated_at: timestampSchema
}).strict();

export const computeLocalQARuntimeSnapshotDigest = (input: unknown): string =>
  digestJson(localQARuntimeSnapshotCoreSchema.parse(input));

export const localQARuntimeSnapshotSchema = localQARuntimeSnapshotCoreSchema.extend({
  snapshot_digest: sha256DigestSchema
}).strict().superRefine((value, context) => {
  const { snapshot_digest: snapshotDigest, ...core } = value;
  if (computeLocalQARuntimeSnapshotDigest(core) !== snapshotDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'snapshot_digest does not match snapshot', path: ['snapshot_digest'] });
  }
  if (value.progress.last_event_sequence !== value.event_sequence) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'progress event sequence must match the Runtime journal', path: ['progress', 'last_event_sequence'] });
  }
  if (value.state === 'terminal') {
    for (const field of ['execution_outcome', 'evidence_outcome', 'upload_outcome', 'cleanup_outcome'] as const) {
      if (value[field] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: `terminal snapshot requires ${field}`, path: [field] });
    }
    if (value.execution_outcome === 'executing') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal Runtime snapshot cannot still be executing', path: ['execution_outcome'] });
    }
    if (value.evidence_outcome === 'staging') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal Runtime snapshot cannot still stage evidence', path: ['evidence_outcome'] });
    }
    if (value.upload_outcome === 'pending') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal Runtime snapshot cannot have pending upload', path: ['upload_outcome'] });
    }
    if (value.cleanup_outcome === 'pending') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal Runtime snapshot cannot have pending cleanup', path: ['cleanup_outcome'] });
    }
    if (value.execution_outcome === 'all_skipped' && value.summary?.all_skipped !== true) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'all-skipped Runtime execution requires exact all-skipped summary counts', path: ['summary'] });
    }
    if (value.execution_outcome === 'passed' && value.summary?.all_skipped === true) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'all-skipped Runtime execution cannot be passed', path: ['execution_outcome'] });
    }
    if (['passed', 'failed', 'blocked', 'error', 'all_skipped'].includes(value.execution_outcome ?? '')) {
      if (value.summary === undefined || value.results?.case_result_set === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'settled Runner execution requires bounded summary and exact CaseResultSet reference',
          path: ['results', 'case_result_set']
        });
      }
    }
    if (['complete', 'partial'].includes(value.evidence_outcome ?? '') && value.results?.evidence_manifest === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'settled evidence requires an exact EvidenceManifest reference', path: ['results', 'evidence_manifest'] });
    }
    if (value.cleanup_outcome !== undefined && value.cleanup_outcome !== 'pending' && value.results?.cleanup_receipt === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'observed cleanup requires an exact CleanupReceipt reference', path: ['results', 'cleanup_receipt'] });
    }
  }
  if (value.results !== undefined) {
    const expected = value.attempt;
    const actual = value.results.binding;
    if (actual.run_id !== expected.run_id || actual.task_id !== expected.task_id ||
        actual.attempt_id !== expected.attempt_id || actual.generation !== expected.generation ||
        actual.fence_token !== expected.fence_token) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal refs are bound to another attempt', path: ['results', 'binding'] });
    }
  }
});

const localQARuntimeEventCoreSchema = z.object({
  schema_version: z.literal('local-qa-runtime-event/v1'),
  event_ref: localQaReferenceSchema,
  run_id: testingRunIdSchema,
  sequence: z.number().int().positive(),
  type: identifierSchema,
  snapshot_digest: sha256DigestSchema,
  reference_projections: z.array(immutableReferenceSchema).max(8),
  created_at: timestampSchema
}).strict();

export const computeLocalQARuntimeEventDigest = (input: unknown): string =>
  digestJson(localQARuntimeEventCoreSchema.parse(input));

export const localQARuntimeEventSchema = localQARuntimeEventCoreSchema.extend({
  event_digest: sha256DigestSchema
}).strict().superRefine((value, context) => {
  const { event_digest: eventDigest, ...core } = value;
  if (computeLocalQARuntimeEventDigest(core) !== eventDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'event_digest does not match Runtime event', path: ['event_digest'] });
  }
});

export const localQARuntimeEventPageSchema = z.object({
  schema_version: z.literal('local-qa-runtime-event-page/v1'),
  run_id: testingRunIdSchema,
  after_sequence: z.number().int().nonnegative(),
  events: z.array(localQARuntimeEventSchema).max(100),
  through_sequence: z.number().int().nonnegative(),
  has_more: z.boolean(),
  snapshot_digest: sha256DigestSchema
}).strict().superRefine((value, context) => {
  let previous = value.after_sequence;
  value.events.forEach((event, index) => {
    if (event.run_id !== value.run_id || event.sequence !== previous + 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Runtime events must be run-bound, contiguous, and strictly ordered', path: ['events', index] });
    }
    previous = event.sequence;
  });
  if (value.through_sequence !== previous) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'through_sequence must equal the last delivered sequence', path: ['through_sequence'] });
  }
  const lastEvent = value.events.at(-1);
  if (lastEvent !== undefined && lastEvent.snapshot_digest !== value.snapshot_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'event page digest must match its last event snapshot', path: ['snapshot_digest'] });
  }
});

const localQARunRequestProjectionSchema = z.object({
  schema_version: z.literal('talos.local-qa-run-request/v1'),
  request_id: identifierSchema,
  idempotency_key: idempotencyKeySchema,
  run_id: testingRunIdSchema,
  task: testingTaskSchema,
  attempt: testingRuntimeAttemptSchema,
  current_claim: testingCurrentClaimEnvelopeSchema,
  issued_at: timestampSchema,
  deadline: timestampSchema
}).strict();

export const computeLocalQARunRequestDigest = (input: unknown): string =>
  digestJson(localQARunRequestProjectionSchema.parse(input));

export const localQARunRequestSchema = localQARunRequestProjectionSchema.extend({
  request_digest: sha256DigestSchema,
  authorization_resolution: testingAuthorizationResolutionSchema,
  authorization: jsonValueSchema
}).strict().superRefine((value, context) => {
  const requestDigest = value.request_digest;
  const resolution = value.authorization_resolution;
  const projection: Record<string, unknown> = { ...value };
  delete projection.request_digest;
  delete projection.authorization_resolution;
  delete projection.authorization;
  if (computeLocalQARunRequestDigest(projection) !== requestDigest || resolution.body_digest !== requestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'request digest is not bound to the exact Runtime projection', path: ['request_digest'] });
  }
  if (
    resolution.http_method !== 'PUT' || resolution.canonical_path !== `/v1/runs/${value.run_id}` ||
    digestJson(resolution.authorization_reference) !== digestJson(value.task.local_request_authorization)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'start authorization method, path, or reference is not exact', path: ['authorization_resolution'] });
  }
  validateOperationBinding(value.attempt, value.current_claim, resolution, value.authorization, 'start', context);
  if (value.task.qa_run_id !== value.run_id || value.task.id !== value.attempt.task_id || value.deadline !== value.attempt.deadline) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'task, request, and attempt bindings differ', path: ['attempt'] });
  }
});

export const localQARunAdmissionSchema = z.object({
  schema_version: z.literal('local-qa-runtime-admission/v1'),
  disposition: z.enum(['new', 'idempotent_replay']),
  accepted: z.literal(true),
  run_id: testingRunIdSchema,
  request_digest: sha256DigestSchema,
  attempt: testingRuntimeAttemptSchema,
  journal_version: z.number().int().positive(),
  snapshot: localQARuntimeSnapshotSchema
}).strict();

const localQAControlRequestProjectionSchema = z.object({
  schema_version: z.literal('talos.local-qa-control-request/v1'),
  request_id: identifierSchema,
  idempotency_key: idempotencyKeySchema,
  effect_id: identifierSchema,
  operation: z.enum(['cancel', 'reconcile']),
  reason: z.enum(['user_cancelled', 'timed_out', 'authority_lost', 'daemon_restart']),
  attempt: testingRuntimeAttemptSchema,
  current_claim: testingCurrentClaimEnvelopeSchema,
  requested_at: timestampSchema,
  deadline: timestampSchema
}).strict();

export const computeLocalQAControlRequestDigest = (input: unknown): string =>
  digestJson(localQAControlRequestProjectionSchema.parse(input));

export const computeLocalQAControlEffectId = (
  operation: 'cancel' | 'reconcile',
  attempt: z.infer<typeof testingRuntimeAttemptSchema>
): string => `${operation}-effect-${digestJson({
  operation,
  run_id: attempt.run_id,
  task_id: attempt.task_id,
  attempt_id: attempt.attempt_id,
  machine_id: attempt.machine_id,
  generation: attempt.generation,
  fence_token: attempt.fence_token
}).slice('sha256:'.length)}`;

export const localQAControlRequestSchema = localQAControlRequestProjectionSchema.extend({
  request_digest: sha256DigestSchema,
  authorization_resolution: testingAuthorizationResolutionSchema,
  authorization: jsonValueSchema
}).strict().superRefine((value, context) => {
  const requestDigest = value.request_digest;
  const resolution = value.authorization_resolution;
  const projection: Record<string, unknown> = { ...value };
  delete projection.request_digest;
  delete projection.authorization_resolution;
  delete projection.authorization;
  if (computeLocalQAControlRequestDigest(projection) !== requestDigest || resolution.body_digest !== requestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'request digest is not bound to the exact Runtime control projection', path: ['request_digest'] });
  }
  const expectedPath = `/v1/runs/${value.attempt.run_id}:${value.operation === 'cancel' ? 'cancel' : 'reconcile-terminal'}`;
  if (resolution.http_method !== 'POST' || resolution.canonical_path !== expectedPath) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'control authorization method or path is not exact', path: ['authorization_resolution'] });
  }
  if (value.effect_id !== computeLocalQAControlEffectId(value.operation, value.attempt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'control effect id is not stable for the bound attempt', path: ['effect_id'] });
  }
  validateOperationBinding(value.attempt, value.current_claim, resolution, value.authorization, value.operation, context);
});

export const localQACancelAckSchema = z.object({
  schema_version: z.literal('local-qa-runtime-cancel-ack/v1'),
  run_id: testingRunIdSchema,
  request_digest: sha256DigestSchema,
  disposition: z.enum(['accepted', 'idempotent_replay', 'already_terminal']),
  cancel_intent_ref: immutableReferenceSchema.optional(),
  snapshot: localQARuntimeSnapshotSchema,
  acknowledged_at: timestampSchema
}).strict().superRefine((value, context) => {
  if (value.disposition !== 'already_terminal' && value.cancel_intent_ref === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'accepted cancellation requires a durable intent ref', path: ['cancel_intent_ref'] });
  }
  if (value.disposition === 'already_terminal' && value.snapshot.state !== 'terminal') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'already-terminal cancellation requires a terminal snapshot', path: ['snapshot', 'state'] });
  }
});

export const localQAReconcileResultSchema = z.discriminatedUnion('disposition', [
  z.object({
    schema_version: z.literal('local-qa-runtime-reconcile-result/v1'),
    disposition: z.literal('terminal'),
    snapshot: localQARuntimeSnapshotSchema
  }).strict(),
  z.object({
    schema_version: z.literal('local-qa-runtime-reconcile-result/v1'),
    disposition: z.literal('pending'),
    snapshot: localQARuntimeSnapshotSchema
  }).strict(),
  z.object({
    schema_version: z.literal('local-qa-runtime-reconcile-result/v1'),
    disposition: z.literal('never_accepted'),
    fact: testingNoLocalAcceptanceFactSchema
  }).strict()
]).superRefine((value, context) => {
  if (value.disposition === 'never_accepted') return;
  if (value.disposition === 'terminal' && value.snapshot.state !== 'terminal') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal reconcile result requires a terminal snapshot', path: ['snapshot', 'state'] });
  }
  if (value.disposition === 'pending' && value.snapshot.state === 'terminal') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'pending reconcile result cannot contain a terminal snapshot', path: ['snapshot', 'state'] });
  }
});

export const testingClaimResponseSchema = z.object({
  task: testingTaskSchema,
  lease: z.object({ lease_id: identifierSchema, lease_expires_at: timestampSchema }).strict(),
  lease_token: z.string().min(1).max(512),
  current_claim: testingCurrentClaimEnvelopeSchema
}).strict();

export const testingReconcileClaimResponseSchema = z.object({
  task: testingReconcileTaskSchema,
  lease_token: z.string().min(1).max(512),
  current_claim: testingCurrentClaimEnvelopeSchema
}).strict();

export const testingWorkerHeartbeatResponseSchema = z.object({
  lease_expires_at: timestampSchema,
  cancel_requested: z.boolean(),
  current_claim: testingCurrentClaimEnvelopeSchema
}).strict();

export const testingWorkerMutationOperationSchema = z.enum([
  'local_accept', 'running', 'terminal', 'reconcile_terminal', 'not_accepted'
]);

const testingWorkerMutationProjectionSchema = z.object({
  schema_version: z.literal('talos.testing-worker-mutation/v1'),
  operation: testingWorkerMutationOperationSchema,
  run_id: testingRunIdSchema,
  attempt_id: identifierSchema,
  generation: z.number().int().positive(),
  fence_token: fenceTokenSchema,
  lease_token: z.string().min(1).max(512),
  payload: jsonValueSchema
}).strict();

export const computeTestingWorkerMutationDigest = (input: unknown): string =>
  digestJson(testingWorkerMutationProjectionSchema.parse(input));

export const testingWorkerMutationAckSchema = z.object({
  schema_version: z.literal('talos.testing-worker-mutation-ack/v1'),
  operation: testingWorkerMutationOperationSchema,
  run_id: testingRunIdSchema,
  attempt_id: identifierSchema,
  generation: z.number().int().positive(),
  fence_token: fenceTokenSchema,
  mutation_digest: sha256DigestSchema,
  control_status: testingControlStatusSchema,
  snapshot_version: z.number().int().positive().optional(),
  current_claim: testingCurrentClaimEnvelopeSchema.optional()
}).strict().superRefine((value, context) => {
  const needsClaim = ['local_accept', 'running'].includes(value.operation);
  if (needsClaim !== (value.current_claim !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'only current-claim mutations return a signed claim', path: ['current_claim'] });
  }
});

export const testingTerminalCommitAckSchema = z.object({
  run_id: testingRunIdSchema,
  control_status: z.enum(['completed', 'failed', 'cancelled']),
  snapshot_version: z.number().int().positive()
}).strict();

const validateOperationBinding = (
  attempt: z.infer<typeof testingRuntimeAttemptSchema>,
  claim: z.infer<typeof testingCurrentClaimEnvelopeSchema>,
  resolution: z.infer<typeof testingAuthorizationResolutionSchema>,
  authorization: z.infer<typeof jsonValueSchema>,
  operation: z.infer<typeof testingRuntimeOperationSchema>,
  context: z.RefinementCtx
): void => {
  const identity = claim.claim;
  const exact = identity.run_id === attempt.run_id && identity.task_id === attempt.task_id &&
    identity.attempt_id === attempt.attempt_id && identity.machine_id === attempt.machine_id &&
    identity.worker_id === attempt.worker_id && identity.generation === attempt.generation &&
    identity.lease_id === attempt.lease_id && identity.fence_token === attempt.fence_token &&
    identity.admission_nonce === attempt.admission_nonce && identity.operation === attempt.operation &&
    claim.claim_digest === attempt.lease_claim.digest;
  const acceptableClaimState = operation === 'cancel'
    ? ['current', 'cancel_requested', 'reconcile_required'].includes(claim.status)
    : claim.is_current;
  if (!exact || !acceptableClaimState || claim.audience !== 'local-qa-runtime') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Runtime request requires an exact current Runtime-audience claim', path: ['current_claim'] });
  }
  if (resolution.operation !== operation ||
      digestJson(authorization) !== resolution.authorization_reference.digest ||
      digestJson(resolution.authorization) !== resolution.authorization_reference.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'authorization is not bound to the requested operation', path: ['authorization_resolution'] });
  }
  if (digestJson(attempt) !== digestJson(resolution.attempt) || resolution.current_claim_digest !== claim.claim_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'authorization is bound to another attempt or claim', path: ['authorization_resolution', 'attempt'] });
  }
};

export type TestingRuntimeOperation = z.infer<typeof testingRuntimeOperationSchema>;
export type TestingRuntimeAttempt = z.infer<typeof testingRuntimeAttemptSchema>;
export type TestingRuntimeExecutionBinding = z.infer<typeof testingRuntimeExecutionBindingSchema>;
export type TestingAuthorizationResolutionRequest = z.infer<typeof testingAuthorizationResolutionRequestSchema>;
export type TestingAuthorizationResolution = z.infer<typeof testingAuthorizationResolutionSchema>;
export type LocalQARuntimeCapabilities = z.infer<typeof localQARuntimeCapabilitiesSchema>;
export type LocalQARuntimeSnapshot = z.infer<typeof localQARuntimeSnapshotSchema>;
export type LocalQARuntimeEventPage = z.infer<typeof localQARuntimeEventPageSchema>;
export type LocalQARunRequest = z.infer<typeof localQARunRequestSchema>;
export type LocalQARunAdmission = z.infer<typeof localQARunAdmissionSchema>;
export type LocalQAControlRequest = z.infer<typeof localQAControlRequestSchema>;
export type LocalQACancelAck = z.infer<typeof localQACancelAckSchema>;
export type LocalQAReconcileResult = z.infer<typeof localQAReconcileResultSchema>;
export type TestingClaimResponse = z.infer<typeof testingClaimResponseSchema>;
export type TestingReconcileClaimResponse = z.infer<typeof testingReconcileClaimResponseSchema>;
export type TestingWorkerHeartbeatResponse = z.infer<typeof testingWorkerHeartbeatResponseSchema>;
export type TestingWorkerMutationOperation = z.infer<typeof testingWorkerMutationOperationSchema>;
export type TestingWorkerMutationAck = z.infer<typeof testingWorkerMutationAckSchema>;
