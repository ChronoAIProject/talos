import { createHash } from 'node:crypto';
import { z } from 'zod';
import { browserActionSchema } from './browser-actions.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema)
]));

const identifierSchema = z.string().trim().min(1).max(255);
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const versionSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const jsonRecordSchema = z.record(jsonValueSchema);

const addDuplicateIssues = (
  values: readonly string[],
  path: readonly (string | number)[],
  context: z.RefinementCtx
): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'identifier must be unique', path: [...path, index] });
    }
    seen.add(value);
  });
};

const addChronologyIssue = (
  startedAt: string,
  completedAt: string,
  context: z.RefinementCtx
): void => {
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'completedAt must not precede startedAt', path: ['completedAt'] });
  }
};

export const qaProtocolVersionSchema = z.literal(1);

export const qaErrorSchema = z.object({
  code: identifierSchema,
  message: z.string().trim().min(1).max(10000),
  retryable: z.boolean().default(false)
}).strict();

export const testingPackageRefSchema = z.object({
  name: identifierSchema,
  version: versionSchema,
  digest: sha256Schema,
  source: z.string().trim().min(1).max(2048).optional()
}).strict();

export const environmentRefSchema = z.object({
  name: identifierSchema,
  version: versionSchema,
  digest: sha256Schema
}).strict();

export const executionPolicySchema = z.object({
  timeoutSeconds: z.number().int().positive().max(86400).default(1800),
  maxAttempts: z.number().int().positive().max(10).default(1),
  failFast: z.boolean().default(false),
  shards: z.number().int().positive().max(128).default(1)
}).strict();

export const testStepPlanSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(500).optional(),
  payload: jsonValueSchema.optional()
}).strict();

export const testCasePlanSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(500),
  tags: z.array(identifierSchema).max(64).default([]),
  steps: z.array(testStepPlanSchema).max(10000).default([]),
  payload: jsonValueSchema.optional()
}).strict().superRefine((value, context) => {
  addDuplicateIssues(value.tags, ['tags'], context);
  addDuplicateIssues(value.steps.map((step) => step.id), ['steps'], context);
});

export const structuredPlanSchema = z.object({
  schemaVersion: qaProtocolVersionSchema,
  id: identifierSchema,
  name: z.string().trim().min(1).max(500),
  package: testingPackageRefSchema,
  environment: environmentRefSchema,
  mode: z.enum(['read_only', 'act']).default('act'),
  cases: z.array(testCasePlanSchema).min(1).max(10000),
  secretRefs: z.array(identifierSchema).max(100).default([]),
  execution: executionPolicySchema.default({})
}).strict().superRefine((value, context) => {
  addDuplicateIssues(value.cases.map((testCase) => testCase.id), ['cases'], context);
  addDuplicateIssues(value.secretRefs, ['secretRefs'], context);
  if (value.execution.shards > value.cases.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'shard count cannot exceed case count',
      path: ['execution', 'shards']
    });
  }
});

export const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(',')}}`;
};

export const digestJson = (value: JsonValue): string =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

export const computeStructuredPlanDigest = (input: z.input<typeof structuredPlanSchema>): string => {
  const normalized = structuredPlanSchema.parse(input);
  return digestJson(jsonValueSchema.parse(normalized));
};

export const verifyStructuredPlanDigest = (
  input: z.input<typeof structuredPlanSchema>,
  digest: string
): boolean => computeStructuredPlanDigest(input) === digest;

export const testingShardSchema = z.object({
  index: z.number().int().nonnegative(),
  total: z.number().int().positive().max(128)
}).strict().refine(({ index, total }) => index < total, {
  message: 'shard index must be less than total',
  path: ['index']
});

export const testingTaskPayloadSchema = z.object({
  schemaVersion: qaProtocolVersionSchema,
  runId: identifierSchema,
  testingTaskId: identifierSchema,
  attempt: z.number().int().positive(),
  fencingToken: z.string().min(16).max(512),
  planDigest: sha256Schema,
  plan: structuredPlanSchema,
  shard: testingShardSchema,
  selectedCaseIds: z.array(identifierSchema).min(1).max(10000)
}).strict().superRefine((value, context) => {
  const planCaseIds = new Set(value.plan.cases.map((testCase) => testCase.id));
  addDuplicateIssues(value.selectedCaseIds, ['selectedCaseIds'], context);
  value.selectedCaseIds.forEach((caseId, index) => {
    if (!planCaseIds.has(caseId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selected case is not present in the plan',
        path: ['selectedCaseIds', index]
      });
    }
  });
  if (value.shard.total !== value.plan.execution.shards) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'shard total must match the plan', path: ['shard', 'total'] });
  }
  if (value.attempt > value.plan.execution.maxAttempts) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'attempt exceeds the plan policy', path: ['attempt'] });
  }
  if (!verifyStructuredPlanDigest(value.plan, value.planDigest)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'plan digest does not match the normalized plan', path: ['planDigest'] });
  }
});

export const assertionSpecSchema = z.object({
  id: identifierSchema,
  subject: z.string().trim().min(1).max(1000),
  operator: z.enum(['equals', 'contains', 'matches', 'visible', 'hidden', 'count', 'custom']),
  expected: jsonValueSchema.optional(),
  message: z.string().trim().min(1).max(2000).optional(),
  metadata: jsonRecordSchema.default({})
}).strict();

export const evidenceKindSchema = z.enum([
  'screenshot',
  'trace',
  'har',
  'video',
  'log',
  'dom',
  'download'
]);

const evidenceBaseSchema = z.object({
  id: identifierSchema,
  runId: identifierSchema,
  testingTaskId: identifierSchema,
  attempt: z.number().int().positive(),
  caseId: identifierSchema.optional(),
  stepId: identifierSchema.optional(),
  kind: evidenceKindSchema,
  contentType: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative(),
  digest: sha256Schema,
  redacted: z.boolean().default(false),
  createdAt: timestampSchema,
  retentionExpiresAt: timestampSchema.optional()
}).strict();

export const evidenceDescriptorSchema = z.discriminatedUnion('state', [
  evidenceBaseSchema.extend({
    state: z.literal('pending'),
    uri: z.never().optional(),
    error: z.never().optional()
  }),
  evidenceBaseSchema.extend({
    state: z.literal('available'),
    uri: z.string().url().max(2048),
    error: z.never().optional()
  }),
  evidenceBaseSchema.extend({
    state: z.literal('failed'),
    uri: z.never().optional(),
    error: qaErrorSchema
  })
]);

export const observationSchema = z.object({
  actionId: identifierSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  page: z.object({
    url: z.string().url().max(2048),
    title: z.string().max(2000)
  }).strict().optional(),
  value: jsonValueSchema.optional(),
  evidenceIds: z.array(identifierSchema).default([]),
  error: qaErrorSchema.optional()
}).strict().superRefine((value, context) => {
  addDuplicateIssues(value.evidenceIds, ['evidenceIds'], context);
  addChronologyIssue(value.startedAt, value.completedAt, context);
});

export const typedTestingActionSchema = z.object({
  id: identifierSchema,
  caseId: identifierSchema,
  stepId: identifierSchema,
  action: browserActionSchema,
  assertions: z.array(assertionSpecSchema).max(1000).default([])
}).strict().superRefine((value, context) => {
  addDuplicateIssues(value.assertions.map((assertion) => assertion.id), ['assertions'], context);
});

const assertionResultBaseSchema = z.object({
  assertionId: identifierSchema,
  expected: jsonValueSchema.optional(),
  actual: jsonValueSchema.optional(),
  message: z.string().max(10000).optional(),
  evidenceIds: z.array(identifierSchema).default([])
}).strict();

export const assertionResultSchema = z.discriminatedUnion('conclusion', [
  assertionResultBaseSchema.extend({ conclusion: z.literal('passed'), error: z.never().optional() }),
  assertionResultBaseSchema.extend({ conclusion: z.literal('failed'), error: z.never().optional() }),
  assertionResultBaseSchema.extend({ conclusion: z.literal('error'), error: qaErrorSchema }),
  assertionResultBaseSchema.extend({ conclusion: z.literal('skipped'), error: z.never().optional() })
]).superRefine((value, context) => {
  addDuplicateIssues(value.evidenceIds, ['evidenceIds'], context);
});

const caseResultBaseSchema = z.object({
  caseId: identifierSchema,
  attempt: z.number().int().positive(),
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  durationMs: z.number().int().nonnegative(),
  assertions: z.array(assertionResultSchema).max(10000),
  evidenceIds: z.array(identifierSchema).default([])
}).strict();

export const caseResultSchema = z.discriminatedUnion('conclusion', [
  caseResultBaseSchema.extend({ conclusion: z.literal('passed'), error: z.never().optional() }),
  caseResultBaseSchema.extend({ conclusion: z.literal('failed'), error: z.never().optional() }),
  caseResultBaseSchema.extend({ conclusion: z.literal('error'), error: qaErrorSchema }),
  caseResultBaseSchema.extend({
    conclusion: z.literal('skipped'),
    assertions: z.array(assertionResultSchema).length(0),
    error: z.never().optional()
  })
]).superRefine((value, context) => {
  addDuplicateIssues(value.assertions.map((result) => result.assertionId), ['assertions'], context);
  addDuplicateIssues(value.evidenceIds, ['evidenceIds'], context);
  addChronologyIssue(value.startedAt, value.completedAt, context);
  if (value.conclusion === 'passed' && value.assertions.some((result) => ['failed', 'error'].includes(result.conclusion))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'passed case cannot contain failed assertions', path: ['assertions'] });
  }
  if (value.conclusion === 'failed' && !value.assertions.some((result) => result.conclusion === 'failed')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'failed case requires a failed assertion', path: ['assertions'] });
  }
});

const cleanupBaseSchema = z.object({
  startedAt: timestampSchema,
  completedAt: timestampSchema
}).strict();

export const cleanupResultSchema = z.discriminatedUnion('conclusion', [
  cleanupBaseSchema.extend({ conclusion: z.literal('succeeded'), errors: z.array(z.never()).length(0).default([]) }),
  cleanupBaseSchema.extend({ conclusion: z.literal('failed'), errors: z.array(qaErrorSchema).min(1) })
]).superRefine((value, context) => addChronologyIssue(value.startedAt, value.completedAt, context));

export const qaRunStatusSchema = z.enum(['queued', 'running', 'cancelling', 'completed']);
export const qaRunConclusionSchema = z.enum(['passed', 'failed', 'error', 'cancelled', 'timed_out']);
export const testingTaskStatusSchema = z.enum([
  'submitted',
  'claimed',
  'preparing',
  'running',
  'cleaning_up',
  'completed'
]);

const qaRunSnapshotBaseSchema = z.object({
  id: identifierSchema,
  userId: identifierSchema,
  planId: identifierSchema,
  planDigest: sha256Schema,
  testingTaskIds: z.array(identifierSchema).min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

const activeQaRunSnapshotSchema = z.discriminatedUnion('status', [
  qaRunSnapshotBaseSchema.extend({
    status: z.literal('queued'),
    conclusion: z.never().optional(),
    startedAt: z.never().optional(),
    completedAt: z.never().optional(),
    error: z.never().optional()
  }),
  qaRunSnapshotBaseSchema.extend({
    status: z.literal('running'),
    conclusion: z.never().optional(),
    startedAt: timestampSchema,
    completedAt: z.never().optional(),
    error: z.never().optional()
  }),
  qaRunSnapshotBaseSchema.extend({
    status: z.literal('cancelling'),
    conclusion: z.never().optional(),
    startedAt: timestampSchema.optional(),
    cancellationRequestedAt: timestampSchema,
    completedAt: z.never().optional(),
    error: z.never().optional()
  })
]);

const completedQaRunSnapshotBaseSchema = qaRunSnapshotBaseSchema.extend({
  status: z.literal('completed'),
  startedAt: timestampSchema.optional(),
  completedAt: timestampSchema
});

const completedQaRunSnapshotSchema = z.discriminatedUnion('conclusion', [
  completedQaRunSnapshotBaseSchema.extend({
    conclusion: z.literal('passed'),
    error: z.never().optional()
  }),
  completedQaRunSnapshotBaseSchema.extend({
    conclusion: z.literal('failed'),
    error: z.never().optional()
  }),
  completedQaRunSnapshotBaseSchema.extend({
    conclusion: z.literal('error'),
    error: qaErrorSchema
  }),
  completedQaRunSnapshotBaseSchema.extend({
    conclusion: z.literal('cancelled'),
    error: z.never().optional()
  }),
  completedQaRunSnapshotBaseSchema.extend({
    status: z.literal('completed'),
    conclusion: z.literal('timed_out'),
    error: qaErrorSchema
  })
]);

export const qaRunSnapshotSchema = z.union([
  activeQaRunSnapshotSchema,
  completedQaRunSnapshotSchema
]).superRefine((value, context) => {
  addDuplicateIssues(value.testingTaskIds, ['testingTaskIds'], context);
});

export const qaRunTransitions: Readonly<Record<z.infer<typeof qaRunStatusSchema>, readonly z.infer<typeof qaRunStatusSchema>[]>> = {
  queued: ['running', 'cancelling', 'completed'],
  running: ['cancelling', 'completed'],
  cancelling: ['completed'],
  completed: []
};

export const isQaRunTransitionAllowed = (
  from: z.infer<typeof qaRunStatusSchema>,
  to: z.infer<typeof qaRunStatusSchema>
): boolean => from !== to && qaRunTransitions[from].includes(to);

const runQueuedPayloadSchema = z.object({ planId: identifierSchema, planDigest: sha256Schema }).strict();
const taskClaimedPayloadSchema = z.object({ workerId: identifierSchema, machineId: identifierSchema }).strict();
const environmentStartedPayloadSchema = z.object({ environment: environmentRefSchema }).strict();
const caseStartedPayloadSchema = z.object({ caseId: identifierSchema }).strict();
const stepCompletedPayloadSchema = z.object({ caseId: identifierSchema, stepId: identifierSchema, observation: observationSchema }).strict();
const assertionCompletedPayloadSchema = z.object({ caseId: identifierSchema, stepId: identifierSchema, result: assertionResultSchema }).strict();
const evidenceCreatedPayloadSchema = z.object({ evidence: evidenceDescriptorSchema }).strict();
const caseCompletedPayloadSchema = z.object({ result: caseResultSchema }).strict();
const cleanupStartedPayloadSchema = z.object({}).strict();
const cleanupCompletedPayloadSchema = z.object({ result: cleanupResultSchema }).strict();
const runCompletedPayloadSchema = z.object({ conclusion: z.enum(['passed', 'failed']), summary: jsonRecordSchema.default({}) }).strict();
const runCancelledPayloadSchema = z.object({ reason: z.string().trim().min(1).max(2000).optional() }).strict();
const runFailedPayloadSchema = z.object({ conclusion: z.enum(['error', 'timed_out']), error: qaErrorSchema }).strict();

const runEventBaseSchema = z.object({
  id: identifierSchema,
  runId: identifierSchema,
  sequence: z.number().int().positive(),
  timestamp: timestampSchema
}).strict();

const taskEventBaseSchema = runEventBaseSchema.extend({
  testingTaskId: identifierSchema,
  attempt: z.number().int().positive()
});

export const qaRunEventSchema = z.discriminatedUnion('type', [
  runEventBaseSchema.extend({ type: z.literal('run.queued'), payload: runQueuedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('task.claimed'), payload: taskClaimedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('environment.started'), payload: environmentStartedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('case.started'), payload: caseStartedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('step.completed'), payload: stepCompletedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('assertion.completed'), payload: assertionCompletedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('evidence.created'), payload: evidenceCreatedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('case.completed'), payload: caseCompletedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('cleanup.started'), payload: cleanupStartedPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal('cleanup.completed'), payload: cleanupCompletedPayloadSchema }),
  runEventBaseSchema.extend({ type: z.literal('run.completed'), payload: runCompletedPayloadSchema }),
  runEventBaseSchema.extend({ type: z.literal('run.cancelled'), payload: runCancelledPayloadSchema }),
  runEventBaseSchema.extend({ type: z.literal('run.failed'), payload: runFailedPayloadSchema })
]);

export const qaRunEventBatchSchema = z.array(qaRunEventSchema).max(1000).superRefine((events, context) => {
  if (events.length === 0) return;
  const runId = events[0]?.runId;
  events.forEach((event, index) => {
    if (event.runId !== runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'event batch must contain one run', path: [index, 'runId'] });
    }
    if (index > 0 && event.sequence <= (events[index - 1]?.sequence ?? 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'event sequences must be strictly increasing', path: [index, 'sequence'] });
    }
  });
});

const workerEventBaseSchema = z.object({ id: identifierSchema, timestamp: timestampSchema }).strict();
const workerEventSchema = z.discriminatedUnion('type', [
  workerEventBaseSchema.extend({ type: z.literal('environment.started'), payload: environmentStartedPayloadSchema }),
  workerEventBaseSchema.extend({ type: z.literal('case.started'), payload: caseStartedPayloadSchema }),
  workerEventBaseSchema.extend({ type: z.literal('step.completed'), payload: stepCompletedPayloadSchema }),
  workerEventBaseSchema.extend({ type: z.literal('assertion.completed'), payload: assertionCompletedPayloadSchema }),
  workerEventBaseSchema.extend({ type: z.literal('evidence.created'), payload: evidenceCreatedPayloadSchema }),
  workerEventBaseSchema.extend({ type: z.literal('case.completed'), payload: caseCompletedPayloadSchema }),
  workerEventBaseSchema.extend({ type: z.literal('cleanup.started'), payload: cleanupStartedPayloadSchema }),
  workerEventBaseSchema.extend({ type: z.literal('cleanup.completed'), payload: cleanupCompletedPayloadSchema })
]);

const testingTaskContextSchema = z.object({
  schemaVersion: qaProtocolVersionSchema,
  runId: identifierSchema,
  testingTaskId: identifierSchema,
  attempt: z.number().int().positive(),
  fencingToken: z.string().min(16).max(512)
}).strict();

export const testingTaskEventSubmissionSchema = testingTaskContextSchema.extend({
  event: workerEventSchema
}).superRefine((value, context) => {
  if (value.event.type === 'evidence.created') {
    const evidence = value.event.payload.evidence;
    if (evidence.runId !== value.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence run must match submission context', path: ['event', 'payload', 'evidence', 'runId'] });
    }
    if (evidence.testingTaskId !== value.testingTaskId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence task must match submission context', path: ['event', 'payload', 'evidence', 'testingTaskId'] });
    }
    if (evidence.attempt !== value.attempt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence attempt must match submission context', path: ['event', 'payload', 'evidence', 'attempt'] });
    }
  }
  if (value.event.type === 'case.completed' && value.event.payload.result.attempt !== value.attempt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'case result attempt must match submission context', path: ['event', 'payload', 'result', 'attempt'] });
  }
});

const testingTaskResultBaseSchema = testingTaskContextSchema.extend({
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  caseResults: z.array(caseResultSchema).max(10000),
  evidenceIds: z.array(identifierSchema).default([]),
  cleanup: cleanupResultSchema
});

export const testingTaskResultSchema = z.discriminatedUnion('conclusion', [
  testingTaskResultBaseSchema.extend({
    conclusion: z.literal('passed'),
    caseResults: z.array(caseResultSchema).min(1).max(10000),
    error: z.never().optional(),
    cancellation: z.never().optional()
  }),
  testingTaskResultBaseSchema.extend({
    conclusion: z.literal('failed'),
    caseResults: z.array(caseResultSchema).min(1).max(10000),
    error: z.never().optional(),
    cancellation: z.never().optional()
  }),
  testingTaskResultBaseSchema.extend({
    conclusion: z.literal('error'),
    error: qaErrorSchema,
    cancellation: z.never().optional()
  }),
  testingTaskResultBaseSchema.extend({
    conclusion: z.literal('cancelled'),
    error: z.never().optional(),
    cancellation: z.object({
      reason: z.string().trim().min(1).max(2000).optional()
    }).strict().default({})
  }),
  testingTaskResultBaseSchema.extend({
    conclusion: z.literal('timed_out'),
    error: qaErrorSchema,
    cancellation: z.never().optional()
  })
]).superRefine((value, context) => {
  addDuplicateIssues(value.caseResults.map((result) => result.caseId), ['caseResults'], context);
  addDuplicateIssues(value.evidenceIds, ['evidenceIds'], context);
  addChronologyIssue(value.startedAt, value.completedAt, context);
  value.caseResults.forEach((result, index) => {
    if (result.attempt !== value.attempt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'case result attempt must match task result', path: ['caseResults', index, 'attempt'] });
    }
  });
  if (value.conclusion === 'passed' && value.caseResults.some((result) => ['failed', 'error'].includes(result.conclusion))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'passed task cannot contain failed cases', path: ['caseResults'] });
  }
  if (value.conclusion === 'failed' && !value.caseResults.some((result) => result.conclusion === 'failed')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'failed task requires a failed case', path: ['caseResults'] });
  }
});

export type QaError = z.infer<typeof qaErrorSchema>;
export type QaErrorInput = z.input<typeof qaErrorSchema>;
export type TestingPackageRef = z.infer<typeof testingPackageRefSchema>;
export type TestingPackageRefInput = z.input<typeof testingPackageRefSchema>;
export type EnvironmentRef = z.infer<typeof environmentRefSchema>;
export type EnvironmentRefInput = z.input<typeof environmentRefSchema>;
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type ExecutionPolicyInput = z.input<typeof executionPolicySchema>;
export type TestStepPlan = z.infer<typeof testStepPlanSchema>;
export type TestStepPlanInput = z.input<typeof testStepPlanSchema>;
export type TestCasePlan = z.infer<typeof testCasePlanSchema>;
export type TestCasePlanInput = z.input<typeof testCasePlanSchema>;
export type StructuredPlan = z.infer<typeof structuredPlanSchema>;
export type StructuredPlanInput = z.input<typeof structuredPlanSchema>;
export type TestingShard = z.infer<typeof testingShardSchema>;
export type TestingShardInput = z.input<typeof testingShardSchema>;
export type TestingTaskPayload = z.infer<typeof testingTaskPayloadSchema>;
export type TestingTaskPayloadInput = z.input<typeof testingTaskPayloadSchema>;
export type AssertionSpec = z.infer<typeof assertionSpecSchema>;
export type AssertionSpecInput = z.input<typeof assertionSpecSchema>;
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type EvidenceDescriptor = z.infer<typeof evidenceDescriptorSchema>;
export type EvidenceDescriptorInput = z.input<typeof evidenceDescriptorSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type ObservationInput = z.input<typeof observationSchema>;
export type TypedTestingAction = z.infer<typeof typedTestingActionSchema>;
export type TypedTestingActionInput = z.input<typeof typedTestingActionSchema>;
export type AssertionResult = z.infer<typeof assertionResultSchema>;
export type AssertionResultInput = z.input<typeof assertionResultSchema>;
export type CaseResult = z.infer<typeof caseResultSchema>;
export type CaseResultInput = z.input<typeof caseResultSchema>;
export type CleanupResult = z.infer<typeof cleanupResultSchema>;
export type CleanupResultInput = z.input<typeof cleanupResultSchema>;
export type QaRunStatus = z.infer<typeof qaRunStatusSchema>;
export type QaRunConclusion = z.infer<typeof qaRunConclusionSchema>;
export type QaRunSnapshot = z.infer<typeof qaRunSnapshotSchema>;
export type QaRunSnapshotInput = z.input<typeof qaRunSnapshotSchema>;
export type TestingTaskStatus = z.infer<typeof testingTaskStatusSchema>;
export type QaRunEvent = z.infer<typeof qaRunEventSchema>;
export type QaRunEventInput = z.input<typeof qaRunEventSchema>;
export type QaRunEventBatchInput = z.input<typeof qaRunEventBatchSchema>;
export type TestingTaskEventSubmission = z.infer<typeof testingTaskEventSubmissionSchema>;
export type TestingTaskEventSubmissionInput = z.input<typeof testingTaskEventSubmissionSchema>;
export type TestingTaskResult = z.infer<typeof testingTaskResultSchema>;
export type TestingTaskResultInput = z.input<typeof testingTaskResultSchema>;
