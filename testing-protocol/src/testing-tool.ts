import { z } from 'zod';
import {
  digestJson,
  identifierSchema,
  sha256DigestSchema,
  terminalReferenceProjectionSchema,
  testingInputReferencesSchema,
  testingPackageReferenceSchema,
  testingRunIdSchema
} from './contracts.js';

const timestampSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const talosReferenceSchema = z.string().min(1).max(2048)
  .regex(/^talos:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/);
const authorizationReferenceSchema = z.string().min(1).max(2048)
  .regex(/^authorization:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/);

export const testingControlStatusSchema = z.enum([
  'submitted',
  'reserved',
  'claimed',
  'local_accepted',
  'running',
  'cancel_requested',
  'closing',
  'reconcile_required',
  'completed',
  'failed',
  'cancelled',
  'abandoned'
]);

export const testingExecutionOutcomeSchema = z.enum([
  'not_started',
  'executing',
  'passed',
  'failed',
  'blocked',
  'error',
  'cancelled',
  'lost_or_inconclusive',
  'unobserved'
]);
export const testingEvidenceOutcomeSchema = z.enum([
  'not_required', 'staging', 'complete', 'partial', 'unavailable', 'policy_blocked'
]);
export const testingUploadOutcomeSchema = z.enum([
  'not_required', 'pending', 'uploaded', 'upload_expired'
]);
export const testingCleanupOutcomeSchema = z.enum([
  'not_required', 'pending', 'complete', 'residual_retryable', 'residual_blocking', 'unobserved'
]);
export const testingCancelReasonSchema = z.enum([
  'user_requested',
  'deadline_exceeded',
  'authorization_revoked',
  'policy_revoked',
  'system_shutdown'
]);

export const testingBudgetsSchema = z.object({
  wall_time_ms: z.number().int().positive().max(600_000),
  max_cases: z.number().int().positive().max(20),
  max_actions: z.number().int().positive().max(200),
  max_events: z.number().int().positive().max(2_000),
  max_screenshots: z.number().int().nonnegative().max(20),
  max_screenshot_bytes: z.number().int().positive().max(5_242_880),
  max_json_evidence_bytes: z.number().int().positive().max(1_048_576),
  max_total_artifact_bytes: z.number().int().positive().max(52_428_800)
}).strict();

export const testingExecutionPolicySchema = z.object({
  network_scope: z.literal('environment_owned_loopback_exact_origins'),
  environment_port_handle_policy: z.object({
    source: z.literal('current_run_owned_handles'),
    allow_unowned_loopback: z.literal(false)
  }).strict(),
  allowed_actions: z.array(z.enum([
    'navigate', 'click', 'type', 'key', 'wait', 'screenshot', 'extract-structured-dom',
    'assert-visible', 'assert-text', 'assert-url'
  ])).min(1).max(11),
  allowed_evidence_media: z.array(z.enum([
    'image/png', 'application/vnd.fkst.testing.sanitized+json'
  ])).min(1).max(2),
  secret_refs: z.array(z.never()).length(0),
  budgets: testingBudgetsSchema
}).strict();

const testingPolicyBindingSchema = z.object({
  policy: z.object({
    schema: z.literal('talos.testing-execution-policy/v1'),
    ref: talosReferenceSchema,
    digest: sha256DigestSchema
  }).strict(),
  budgets: z.object({
    schema: z.literal('talos.testing-budgets/v1'),
    ref: talosReferenceSchema,
    digest: sha256DigestSchema
  }).strict()
}).strict();

export const testingToolRequestSchema = z.object({
  schema_version: z.literal('talos.testing-tool-request/v1'),
  idempotency_key: idempotencyKeySchema,
  display_goal: z.string().min(1).max(1_000),
  inputs: testingInputReferencesSchema,
  execution_profile: z.literal('local_qa_agent_mvp'),
  placement_requirements: z.object({
    testing_runtime: z.literal('local-qa-mvp/v1')
  }).strict(),
  policy_binding: testingPolicyBindingSchema,
  policy: testingExecutionPolicySchema
}).strict().superRefine((value, context) => {
  if (value.policy_binding.policy.digest !== digestJson(value.policy)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'policy digest does not match bounded policy projection',
      path: ['policy_binding', 'policy', 'digest']
    });
  }
  if (value.policy_binding.budgets.digest !== digestJson(value.policy.budgets)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'budgets digest does not match bounded budgets projection',
      path: ['policy_binding', 'budgets', 'digest']
    });
  }
});

export const computeTestingToolRequestDigest = (
  runId: string,
  input: z.input<typeof testingToolRequestSchema>
): string => digestJson({ run_id: testingRunIdSchema.parse(runId), request: testingToolRequestSchema.parse(input) });

export const testingCapabilitiesSchema = z.object({
  schema_version: z.literal('talos.testing-capabilities/v1'),
  planning_contracts: z.tuple([
    z.literal('pql.project-pack-snapshot/v1'),
    z.literal('pql.test-selection/v1'),
    z.literal('pql.testing-design-input-set.v1')
  ]),
  tool_contracts: z.tuple([z.literal('talos.testing-tool-request/v1')]),
  task_contracts: z.tuple([z.literal('talos.testing-task/v1')]),
  execution_profiles: z.tuple([z.literal('local_qa_agent_mvp')]),
  runtime_capabilities: z.tuple([z.literal('local-qa-mvp/v1')]),
  result_contracts: z.tuple([
    z.literal('testing-case-result-set.v2'),
    z.literal('testing-evidence-manifest.v1'),
    z.literal('qa.local-cleanup-receipt/v2')
  ]),
  backends: z.tuple([z.literal('browser')]),
  browsers: z.tuple([z.literal('chromium')]),
  secret_refs_supported: z.literal(false),
  max_concurrency_per_machine: z.literal(1),
  limits: testingBudgetsSchema
}).strict();

export const testingRunAcceptanceSchema = z.object({
  schema_version: z.literal('talos.testing-run-acceptance/v1'),
  run_id: testingRunIdSchema,
  accepted: z.literal(true),
  replayed: z.boolean(),
  control_status: testingControlStatusSchema,
  request_digest: sha256DigestSchema,
  created_at: timestampSchema
}).strict();

export const testingRunAttemptProjectionSchema = z.object({
  attempt_id: identifierSchema,
  task_id: identifierSchema,
  generation: z.number().int().positive(),
  machine_id: identifierSchema.optional()
}).strict();

export const testingRunProgressSchema = z.object({
  phase: identifierSchema,
  completed_cases: z.number().int().nonnegative(),
  total_cases: z.number().int().nonnegative(),
  last_event_sequence: z.number().int().nonnegative()
}).strict().refine((value) => value.completed_cases <= value.total_cases, {
  message: 'completed_cases cannot exceed total_cases',
  path: ['completed_cases']
});

export const testingRunSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  error: z.number().int().nonnegative()
}).strict().refine((value) => value.passed + value.failed + value.blocked + value.error <= value.total, {
  message: 'summary outcomes cannot exceed total'
});

export const testingTerminalRefsSchema = terminalReferenceProjectionSchema;

export const testingSafeErrorSchema = z.object({
  code: identifierSchema,
  message: z.string().min(1).max(4_096),
  retryable: z.boolean()
}).strict();

const testingRunSnapshotObjectSchema = z.object({
  schema_version: z.literal('talos.testing-run-snapshot/v1'),
  run_id: testingRunIdSchema,
  snapshot_version: z.number().int().positive(),
  snapshot_ref: talosReferenceSchema,
  control_status: testingControlStatusSchema,
  execution_outcome: testingExecutionOutcomeSchema,
  evidence_outcome: testingEvidenceOutcomeSchema,
  upload_outcome: testingUploadOutcomeSchema,
  cleanup_outcome: testingCleanupOutcomeSchema,
  attempt: testingRunAttemptProjectionSchema.nullable(),
  progress: testingRunProgressSchema,
  summary: testingRunSummarySchema.nullable(),
  results: testingTerminalRefsSchema.nullable(),
  safe_error: testingSafeErrorSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();

const validateSnapshotResultBinding = (
  value: z.infer<typeof testingRunSnapshotObjectSchema>,
  context: z.RefinementCtx
): void => {
  if (value.results === null) return;
  if (value.attempt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'terminal results require a current attempt',
      path: ['results', 'binding']
    });
    return;
  }
  const expected = {
    run_id: value.run_id,
    task_id: value.attempt.task_id,
    attempt_id: value.attempt.attempt_id,
    generation: value.attempt.generation
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value.results.binding[field as keyof typeof expected] !== expectedValue) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `terminal results ${field} must match snapshot attempt`,
        path: ['results', 'binding', field]
      });
    }
  }
};

export const testingRunSnapshotCoreSchema = testingRunSnapshotObjectSchema.superRefine(
  validateSnapshotResultBinding
);

export const computeTestingRunSnapshotDigest = (
  input: z.input<typeof testingRunSnapshotCoreSchema>
): string => digestJson(testingRunSnapshotCoreSchema.parse(input));

export const testingRunSnapshotSchema = testingRunSnapshotObjectSchema.extend({
  snapshot_digest: sha256DigestSchema,
  resume_cursor: z.string().min(32).max(4_096)
}).strict().superRefine((value, context) => {
  const snapshotDigest = value.snapshot_digest;
  const core: Record<string, unknown> = { ...value };
  delete core.snapshot_digest;
  delete core.resume_cursor;
  if (digestJson(testingRunSnapshotObjectSchema.parse(core)) !== snapshotDigest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'snapshot_digest does not match snapshot',
      path: ['snapshot_digest']
    });
  }
  validateSnapshotResultBinding(value, context);
});

export const testingRunEventTypeSchema = z.enum([
  'run.submitted',
  'run.reserved',
  'attempt.claimed',
  'attempt.local_accepted',
  'run.started',
  'run.cancel_requested',
  'run.closing',
  'run.reconcile_required',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.abandoned'
]);

const testingRunEventBaseSchema = z.object({
  sequence: z.number().int().positive(),
  time: timestampSchema
}).strict();

const runSubmittedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.submitted'),
  data: z.object({ request_digest: sha256DigestSchema }).strict()
}).strict();
const runReservedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.reserved'),
  data: z.object({ task_id: identifierSchema }).strict()
}).strict();
const attemptClaimedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('attempt.claimed'),
  data: z.object({
    task_id: identifierSchema,
    attempt_id: identifierSchema,
    generation: z.number().int().positive(),
    machine_id: identifierSchema
  }).strict()
}).strict();
const attemptLocalAcceptedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('attempt.local_accepted'),
  data: z.object({ attempt_id: identifierSchema, generation: z.number().int().positive() }).strict()
}).strict();
const runStartedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.started'),
  data: z.object({ attempt_id: identifierSchema, generation: z.number().int().positive() }).strict()
}).strict();
const runCancelRequestedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.cancel_requested'),
  data: z.object({ reason_code: testingCancelReasonSchema }).strict()
}).strict();
const runClosingEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.closing'),
  data: z.object({ reason_code: identifierSchema }).strict()
}).strict();
const runReconcileRequiredEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.reconcile_required'),
  data: z.object({ attempt_id: identifierSchema, reason_code: identifierSchema }).strict()
}).strict();
const runCompletedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.completed'),
  data: z.object({ execution_outcome: testingExecutionOutcomeSchema }).strict()
}).strict();
const runFailedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.failed'),
  data: z.object({ error_code: identifierSchema }).strict()
}).strict();
const runCancelledEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.cancelled'),
  data: z.object({ cleanup_outcome: testingCleanupOutcomeSchema }).strict()
}).strict();
const runAbandonedEventCoreSchema = testingRunEventBaseSchema.extend({
  type: z.literal('run.abandoned'),
  data: z.object({ reason_code: identifierSchema }).strict()
}).strict();

export const testingRunEventCoreSchema = z.discriminatedUnion('type', [
  runSubmittedEventCoreSchema,
  runReservedEventCoreSchema,
  attemptClaimedEventCoreSchema,
  attemptLocalAcceptedEventCoreSchema,
  runStartedEventCoreSchema,
  runCancelRequestedEventCoreSchema,
  runClosingEventCoreSchema,
  runReconcileRequiredEventCoreSchema,
  runCompletedEventCoreSchema,
  runFailedEventCoreSchema,
  runCancelledEventCoreSchema,
  runAbandonedEventCoreSchema
]);

export const computeTestingRunEventDigest = (
  input: unknown
): string => digestJson(testingRunEventCoreSchema.parse(input));

export const testingRunEventSchema = z.discriminatedUnion('type', [
  runSubmittedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runReservedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  attemptClaimedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  attemptLocalAcceptedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runStartedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runCancelRequestedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runClosingEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runReconcileRequiredEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runCompletedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runFailedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runCancelledEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict(),
  runAbandonedEventCoreSchema.extend({ event_digest: sha256DigestSchema }).strict()
]).superRefine((value, context) => {
  const { event_digest: eventDigest, ...core } = value;
  if (computeTestingRunEventDigest(core) !== eventDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'event_digest does not match event', path: ['event_digest'] });
  }
});

export const testingEventPageSchema = z.object({
  schema_version: z.literal('talos.testing-event-page/v1'),
  run_id: testingRunIdSchema,
  events: z.array(testingRunEventSchema).max(100),
  next_cursor: z.string().min(32).max(4_096),
  has_more: z.boolean()
}).strict().superRefine((value, context) => {
  value.events.forEach((event, index) => {
    if (index > 0 && event.sequence <= (value.events[index - 1]?.sequence ?? 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'event sequences must increase', path: ['events', index, 'sequence'] });
    }
  });
});

export const testingEventQuerySchema = z.object({
  cursor: z.string().min(32).max(4_096).optional(),
  limit: z.coerce.number().int().positive().max(100).default(100)
}).strict();

export const testingCancelRequestSchema = z.object({
  schema_version: z.literal('talos.testing-cancel-request/v1'),
  idempotency_scope: z.string().min(1).max(768),
  idempotency_key: idempotencyKeySchema,
  canonical_request_digest: sha256DigestSchema,
  reason: testingCancelReasonSchema
}).strict();

export const computeTestingCancelRequestDigest = (
  runId: string,
  input: Omit<z.input<typeof testingCancelRequestSchema>, 'canonical_request_digest'>
): string => digestJson({ run_id: testingRunIdSchema.parse(runId), request: input });

export const testingCancelAckSchema = z.object({
  schema_version: z.literal('talos.testing-cancel-ack/v1'),
  run_id: testingRunIdSchema,
  accepted: z.literal(true),
  replayed: z.boolean(),
  already_terminal: z.boolean(),
  control_status: testingControlStatusSchema,
  canonical_request_digest: sha256DigestSchema
}).strict();

export const testingTaskSchema = z.object({
  schema_version: z.literal('talos.testing-task/v1'),
  id: identifierSchema,
  kind: z.literal('testing'),
  interaction: z.literal('managed'),
  qa_run_id: testingRunIdSchema,
  dispatch_attempt_id: identifierSchema,
  generation: z.number().int().positive(),
  machine_id: identifierSchema,
  inputs: testingInputReferencesSchema,
  runner: testingPackageReferenceSchema,
  policy_ref: z.object({
    schema: z.literal('talos.testing-execution-policy/v1'),
    ref: talosReferenceSchema,
    digest: sha256DigestSchema
  }).strict(),
  budgets_ref: z.object({
    schema: z.literal('talos.testing-budgets/v1'),
    ref: talosReferenceSchema,
    digest: sha256DigestSchema
  }).strict(),
  local_request_authorization: z.object({
    ref: authorizationReferenceSchema,
    digest: sha256DigestSchema,
    expires_at: timestampSchema
  }).strict(),
  expected_runtime_capability: z.literal('local-qa-mvp/v1'),
  deadline: timestampSchema
}).strict().superRefine((value, context) => {
  if (JSON.stringify(value.runner) !== JSON.stringify(value.inputs.testing_package)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'runner must match frozen testing package', path: ['runner'] });
  }
});

export type TestingToolRequest = z.infer<typeof testingToolRequestSchema>;
export type TestingCapabilities = z.infer<typeof testingCapabilitiesSchema>;
export type TestingRunAcceptance = z.infer<typeof testingRunAcceptanceSchema>;
export type TestingControlStatus = z.infer<typeof testingControlStatusSchema>;
export type TestingExecutionOutcome = z.infer<typeof testingExecutionOutcomeSchema>;
export type TestingEvidenceOutcome = z.infer<typeof testingEvidenceOutcomeSchema>;
export type TestingUploadOutcome = z.infer<typeof testingUploadOutcomeSchema>;
export type TestingCleanupOutcome = z.infer<typeof testingCleanupOutcomeSchema>;
export type TestingRunAttemptProjection = z.infer<typeof testingRunAttemptProjectionSchema>;
export type TestingRunProgress = z.infer<typeof testingRunProgressSchema>;
export type TestingRunSummary = z.infer<typeof testingRunSummarySchema>;
export type TestingTerminalRefs = z.infer<typeof testingTerminalRefsSchema>;
export type TestingSafeError = z.infer<typeof testingSafeErrorSchema>;
export type TestingRunSnapshotCore = z.infer<typeof testingRunSnapshotCoreSchema>;
export type TestingRunSnapshot = z.infer<typeof testingRunSnapshotSchema>;
export type TestingRunEvent = z.infer<typeof testingRunEventSchema>;
export type TestingEventPage = z.infer<typeof testingEventPageSchema>;
export type TestingCancelRequest = z.infer<typeof testingCancelRequestSchema>;
export type TestingCancelAck = z.infer<typeof testingCancelAckSchema>;
export type TestingTask = z.infer<typeof testingTaskSchema>;
