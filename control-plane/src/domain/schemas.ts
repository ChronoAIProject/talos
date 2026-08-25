import { z } from 'zod';
import {
  browserActionSchema,
  testingCleanupOutcomeSchema,
  testingEvidenceOutcomeSchema,
  testingExecutionOutcomeSchema,
  testingRunSummarySchema,
  testingSafeErrorSchema,
  testingNoLocalAcceptanceFactSchema,
  testingTerminalRefsSchema,
  testingUploadOutcomeSchema
} from '@talos/testing-protocol';

export const capabilityTagSchema = z.enum([
  'os',
  'region',
  'residential_ip',
  'headed_display',
  'browser',
  'computer_use'
]);

const requirementsSchema = z.record(
  capabilityTagSchema,
  z.union([z.string().min(1), z.boolean()])
);

export const sessionActionSchema = browserActionSchema;

export const sessionCreateSchema = z.object({
  pool_id: z.string().trim().min(1).max(255).optional(),
  profile_id: z.string().trim().min(1).max(255).optional(),
  mode: z.enum(['read_only', 'act']).default('read_only'),
  constraints: z.object({
    budget: z.number().finite().nonnegative().optional(),
    deadline: z.string().datetime({ offset: true }).optional(),
    requirements: requirementsSchema.optional()
  }).default({})
}).strict();

export const sessionActionRequestSchema = z.object({ action: sessionActionSchema }).strict();
export const sessionCloseSchema = z.object({}).strict();
export const sessionWaitSchema = z.coerce.number().int().min(0).max(25).default(25);

export const taskCreateSchema = z.object({
  kind: z.enum(['browse', 'computer_use']),
  goal: z.string().trim().min(1).max(10000),
  site_hint: z.string().trim().min(1).max(255).optional(),
  profile_id: z.string().trim().min(1).max(255).optional(),
  pool_id: z.string().trim().min(1).max(255).optional(),
  constraints: z
    .object({
      budget: z.number().finite().nonnegative().optional(),
      deadline: z.string().datetime({ offset: true }).optional(),
      requirements: requirementsSchema.optional()
    })
    .default({}),
  mode: z.enum(['read_only', 'act']).default('read_only'),
  callback: z.string().url().max(2048).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'callback must use http or https').optional()
});

export const taskInputSchema = z.object({
  kind: z.enum(['choice', 'text', 'otp']),
  value: z.string().min(1).max(10000)
});

export const handoffRequestSchema = z.object({
  expires_in_seconds: z.number().int().positive().max(3600).default(900)
});

export const workerBodyCredentialsSchema = z.object({
  worker_token: z.string().min(1).optional(),
  worker_id: z.string().trim().min(1).max(255).optional(),
  machine_id: z.string().trim().min(1).max(255).optional()
});

export const workerClaimSchema = workerBodyCredentialsSchema.extend({
  worker_id: z.string().trim().min(1).max(255),
  machine_id: z.string().trim().min(1).max(255)
});

export const testingWorkerClaimSchema = z.object({
  worker_token: z.string().min(1).optional(),
  worker_id: z.string().trim().min(1).max(255),
  machine_id: z.string().trim().min(1).max(255)
}).strict();

export const heartbeatSchema = workerBodyCredentialsSchema.extend({
  lease_token: z.string().min(1),
  extend_seconds: z.number().int().positive().max(300).default(60)
});

const testingWorkerCredentialsShape = {
  worker_token: z.string().min(1).optional(),
  worker_id: z.string().trim().min(1).max(255).optional(),
  machine_id: z.string().trim().min(1).max(255).optional()
};

export const testingAttemptBindingBodySchema = z.object({
  ...testingWorkerCredentialsShape,
  attempt_id: z.string().trim().min(1).max(255),
  generation: z.number().int().positive(),
  fence_token: z.string().min(16).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  lease_token: z.string().min(1).max(512)
}).strict();

export const testingHeartbeatBodySchema = testingAttemptBindingBodySchema.extend({
  extend_seconds: z.number().int().positive().max(300).default(60),
  progress: z.object({
    phase: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    completed_cases: z.number().int().nonnegative(),
    total_cases: z.number().int().nonnegative(),
    runtime_event_sequence: z.number().int().nonnegative()
  }).strict().refine((value) => value.completed_cases <= value.total_cases, {
    message: 'completed_cases cannot exceed total_cases',
    path: ['completed_cases']
  }).optional()
}).strict();

export const testingTerminalCommitBodySchema = testingAttemptBindingBodySchema.extend({
  control_status: z.enum(['completed', 'failed', 'cancelled']),
  execution_outcome: testingExecutionOutcomeSchema,
  evidence_outcome: testingEvidenceOutcomeSchema,
  upload_outcome: testingUploadOutcomeSchema,
  cleanup_outcome: testingCleanupOutcomeSchema,
  summary: testingRunSummarySchema.optional(),
  results: testingTerminalRefsSchema.optional(),
  safe_error: testingSafeErrorSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.execution_outcome === 'executing') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal commit cannot still be executing', path: ['execution_outcome'] });
  }
  if (value.evidence_outcome === 'staging') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal commit cannot still stage evidence', path: ['evidence_outcome'] });
  }
  if (value.cleanup_outcome === 'pending') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal commit cannot have pending cleanup', path: ['cleanup_outcome'] });
  }
});

export const testingNoLocalAcceptanceBodySchema = testingAttemptBindingBodySchema.extend({
  fact: testingNoLocalAcceptanceFactSchema
}).strict();

export const workerNeedsInputSchema = workerBodyCredentialsSchema.extend({
  lease_token: z.string().min(1)
});

export const workerInputPollSchema = workerNeedsInputSchema;

export const workerActionPollSchema = workerNeedsInputSchema;

export const workerActionResultSchema = workerBodyCredentialsSchema.extend({
  lease_token: z.string().min(1),
  result: z.object({
    screenshot: z.object({
      mimeType: z.enum(['image/jpeg', 'image/png']),
      data: z.string(),
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative()
    }).optional(),
    value: z.unknown().optional(),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional()
  }).strict()
});

export const resultSchema = workerBodyCredentialsSchema.extend({
  lease_token: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  findings: z
    .array(
      z.object({
        key: z.string().min(1).max(255),
        value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])
      })
    )
    .default([]),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional()
});

export const artifactSchema = workerBodyCredentialsSchema.extend({
  lease_token: z.string().min(1),
  name: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  uri: z.string().url().max(2048)
});

export const adminPoolSchema = z.object({
  id: z.string().min(1),
  visibility: z.enum(['private', 'org', 'platform']),
  owner_user_id: z.string().min(1).optional(),
  tags: z.record(z.union([z.string(), z.boolean()])).default({}),
  shared_with_groups: z.array(z.string().trim().min(1).max(255)).default([])
});

export const adminMachineSchema = z.object({
  id: z.string().min(1),
  pool_id: z.string().min(1),
  tags: z.record(z.union([z.string(), z.boolean()])).default({}),
  capacity: z.number().int().positive().default(1),
  online: z.boolean().default(true),
  worker_token: z.string().min(16).optional()
});

export const adminRotateMachineSchema = z.object({ worker_token: z.string().min(16).optional() });

export const adminProfileSchema = z.object({ id: z.string().min(1), user_id: z.string().min(1), machine_id: z.string().min(1).optional() });

export const selfPoolSchema = z.object({
  id: z.string().trim().min(1).max(255).optional(),
  visibility: z.enum(['private', 'org']).optional(),
  tags: z.record(z.union([z.string(), z.boolean()])).default({}),
  shared_with_groups: z.array(z.string().trim().min(1).max(255)).default([])
}).strict();

export const selfPoolPatchSchema = z.object({
  visibility: z.enum(['private', 'org']).optional(),
  shared_with_groups: z.array(z.string().trim().min(1).max(255)).optional(),
  tags: z.record(z.union([z.string(), z.boolean()])).optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'at least one pool field is required');

export const selfMachineSchema = z.object({
  id: z.string().trim().min(1).max(255),
  tags: z.record(z.union([z.string(), z.boolean()])).default({}),
  capacity: z.number().int().positive().default(1),
  online: z.boolean().default(true)
}).strict();

export const selfRotateMachineSchema = z.object({}).strict();

export const selfProfileSchema = z.object({
  id: z.string().trim().min(1).max(255).optional(),
  machine_id: z.string().trim().min(1).max(255).optional()
}).strict();

export type TaskCreateRequest = z.infer<typeof taskCreateSchema>;
export type TaskInputRequest = z.infer<typeof taskInputSchema>;
